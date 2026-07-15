import { test, expect } from "@playwright/test";

/**
 * API-level E2E through the real nginx → backend → Mistral path (no browser UI).
 * Uses Playwright's request fixture, which honors baseURL (:8080). These verify
 * the frontend↔backend contract and the pipeline as the deployed stack serves
 * it — complementing the mocked supertest integration suite.
 */

test.describe("Pipeline over the deployed stack", () => {
  // A tiny 1x1 PNG (well under nginx's limit) as the card image.
  const smallPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  test("submit → recognize → extract runs end to end via nginx", async ({ request }) => {
    const submit = await request.post("/api/cards", {
      multipart: {
        mode: "single",
        frontImage: { name: "card.png", mimeType: "image/png", buffer: smallPng },
      },
    });
    expect(submit.status()).toBe(201);
    const { cardId } = await submit.json();
    expect(cardId).toBeTruthy();

    const recognize = await request.post(`/api/cards/${cardId}/recognize`);
    expect(recognize.status()).toBe(200);
    expect(await recognize.json()).toHaveProperty("rawText");

    const extract = await request.post(`/api/cards/${cardId}/extract`);
    expect(extract.status()).toBe(200);
    expect((await extract.json()).contact).toHaveProperty("name");
  });

  test("auth status is reachable through nginx and reports unauthenticated", async ({
    request,
  }) => {
    const res = await request.get("/api/auth/google/status");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  test("saving without auth returns 401 through nginx", async ({ request }) => {
    const res = await request.post("/api/contacts/save", {
      data: { cardId: "x", contact: { name: "Ada" } },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("nginx upload size limit (regression: real camera photos)", () => {
  /**
   * Regression for the fixed 413 bug: nginx.conf now sets
   * `client_max_body_size 10m`, so a realistic ~1.5MB phone photo passes
   * through to the backend instead of being rejected at the edge. The backend's
   * multer applies the same 10MB cap as the enforcing backstop.
   *
   * (History: before the fix, nginx's 1MB default 413'd this upload — confirmed
   * live 2026-07-14 across all browsers.)
   */
  test("a ~1.5MB upload passes nginx and reaches the backend (201)", async ({ request }) => {
    const bigJpeg = Buffer.alloc(1_500_000, 0x7f); // ~1.5MB — was 413 pre-fix
    const res = await request.post("/api/cards", {
      multipart: {
        mode: "single",
        frontImage: { name: "big.jpg", mimeType: "image/jpeg", buffer: bigJpeg },
      },
    });
    expect(res.status()).toBe(201);
  });

  test("an over-10MB upload is rejected at the nginx edge with 413", async ({ request }) => {
    // Through nginx, `client_max_body_size 10m` rejects at the edge (413). The
    // backend's multer backstop (a clean 400) is exercised in the backend
    // integration suite, which hits Express directly, bypassing nginx.
    const tooBig = Buffer.alloc(11 * 1024 * 1024, 0x7f);
    const res = await request.post("/api/cards", {
      multipart: {
        mode: "single",
        frontImage: { name: "huge.jpg", mimeType: "image/jpeg", buffer: tooBig },
      },
    });
    expect(res.status()).toBe(413);
  });
});
