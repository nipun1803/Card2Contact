import { describe, expect, it, vi, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

/**
 * Integration test: drives the real Express app (all routers wired via
 * createApp) end-to-end over HTTP with supertest. External SDK boundaries are
 * mocked so the run is deterministic and offline:
 *   - Mistral OCR returns a canned business-card text block.
 *   - google-auth-library / googleapis are stubbed (only needed for the save
 *     path, tested separately in auth.test.ts).
 *
 * This proves the M1→M2→M3→M4 wiring, status codes, JSON shapes, and the
 * cross-cutting error conventions (404/409/400) behave as documented.
 */

const OCR_TEXT = [
  "Ada Lovelace",
  "Chief Analyst",
  "Analytical Engines Inc",
  "ada@analyticalengines.com",
  "+1 555 010 1842",
].join("\n");

vi.mock("@mistralai/mistralai", () => ({
  Mistral: vi.fn().mockImplementation(() => ({
    ocr: { process: vi.fn(async () => ({ pages: [{ markdown: OCR_TEXT }] })) },
  })),
}));

// The pipeline routes (M1-M4) don't touch Google, but createApp constructs the
// auth client, so provide harmless stubs.
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/mock"),
    getToken: vi.fn(),
    verifyIdToken: vi.fn(),
    setCredentials: vi.fn(),
    on: vi.fn(),
  })),
}));

import { buildTestApp } from "../helpers/app";

let app: Express;
beforeAll(() => {
  app = buildTestApp();
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("M1→M4 pipeline over HTTP", () => {
  it("runs the happy path submit → recognize → extract → confirm", async () => {
    // M1
    const submit = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", PNG, "card.png");
    expect(submit.status).toBe(201);
    expect(submit.body).toMatchObject({ mode: "single" });
    const cardId: string = submit.body.cardId;
    expect(cardId).toBeTruthy();

    // M2
    const recognize = await request(app).post(`/api/cards/${cardId}/recognize`);
    expect(recognize.status).toBe(200);
    expect(recognize.body.rawText).toContain("Ada Lovelace");

    // M3
    const extract = await request(app).post(`/api/cards/${cardId}/extract`);
    expect(extract.status).toBe(200);
    expect(extract.body.contact.name).toBe("Ada Lovelace");
    expect(extract.body.contact.designation).toBe("Chief Analyst");
    expect(extract.body.contact.email).toBe("ada@analyticalengines.com");
    expect(extract.body.contact.company).toBe("Analytical Engines Inc");

    // M4 edit + confirm
    const patch = await request(app)
      .patch(`/api/cards/${cardId}/contact`)
      .send({ category: "Client" });
    expect(patch.status).toBe(200);
    expect(patch.body.contact.category).toBe("Client");

    const confirm = await request(app).post(`/api/cards/${cardId}/confirm`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.confirmed).toBe(true);
  });

  it("returns 400 when submitting a card with no image", async () => {
    const res = await request(app).post("/api/cards").field("mode", "single");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/without at least one image/);
  });

  it("returns 400 for an invalid mode", async () => {
    const res = await request(app)
      .post("/api/cards")
      .field("mode", "triple")
      .attach("frontImage", PNG, "card.png");
    expect(res.status).toBe(400);
  });

  it("accepts an upload just under the 10MB limit", async () => {
    const almostMax = Buffer.alloc(9 * 1024 * 1024, 0x7f);
    const res = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", almostMax, "big.jpg");
    expect(res.status).toBe(201);
  });

  it("rejects an over-limit upload with a clean 400 (not a 500 MulterError)", async () => {
    const tooBig = Buffer.alloc(11 * 1024 * 1024, 0x7f);
    const res = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", tooBig, "huge.jpg");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });

  it("returns 404 for recognize on an unknown card", async () => {
    const res = await request(app).post("/api/cards/does-not-exist/recognize");
    expect(res.status).toBe(404);
  });

  it("returns 409 when extract is called before recognize (out of order)", async () => {
    const submit = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", PNG, "card.png");
    const cardId = submit.body.cardId;

    const res = await request(app).post(`/api/cards/${cardId}/extract`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/text recognition/);
  });

  it("returns 400 when confirming with an empty name", async () => {
    const submit = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", PNG, "card.png");
    const cardId = submit.body.cardId;
    await request(app).post(`/api/cards/${cardId}/recognize`);
    await request(app).post(`/api/cards/${cardId}/extract`);
    await request(app).patch(`/api/cards/${cardId}/contact`).send({ name: "" });

    const res = await request(app).post(`/api/cards/${cardId}/confirm`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Name is required/);
  });
});

describe("M5 save auth gate", () => {
  it("returns 401 when saving without a session cookie", async () => {
    const res = await request(app)
      .post("/api/contacts/save")
      .send({ cardId: "whatever", contact: { name: "Ada" } });
    expect(res.status).toBe(401);
  });

  it("returns 400 for a missing cardId even before auth is checked? (auth first)", async () => {
    // requireAuth runs before body validation, so an unauthenticated malformed
    // request is still a 401 — documents the middleware order.
    const res = await request(app).post("/api/contacts/save").send({});
    expect(res.status).toBe(401);
  });
});
