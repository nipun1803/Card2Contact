import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../src/shared/http/error-handler";
import { ValidationError } from "../../src/shared/http/pipeline-errors";

/**
 * body-parser rejections are CLIENT faults and must be reported as such.
 *
 * Before this branch existed they fell through to the generic 500 — so an
 * oversized or malformed request told the caller "Internal server error",
 * sending them to look for a server bug that was never there. body-parser
 * already computes the right status; the handler just has to honour it.
 *
 * These run against a bare app rather than the real one: the behaviour is a
 * property of the shared handler, and every route that parses a JSON body
 * inherits it.
 */
function app() {
  const a = express();
  a.use(express.json());
  a.post("/x", (_req, res) => res.json({ ok: true }));
  a.get("/boom", () => {
    throw new Error("something genuinely broke");
  });
  a.get("/domain", () => {
    throw new ValidationError("bad input");
  });
  a.use(errorHandler);
  return a;
}

describe("errorHandler — body-parser rejections", () => {
  it("413s a body over the 100kb limit, with a message that names the cause", async () => {
    const res = await request(app()).post("/x").send({ big: "x".repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body is too large" });
  });

  it("400s malformed JSON", async () => {
    const res = await request(app())
      .post("/x")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Request body is not valid JSON" });
  });

  it("does not echo body-parser's internal detail to the client", async () => {
    // body-parser's own message quotes the configured limit and parse offsets —
    // detail a client neither needs nor should be handed.
    const res = await request(app()).post("/x").send({ big: "x".repeat(200_000) });

    expect(JSON.stringify(res.body)).not.toMatch(/100kb|limit|entity\.too\.large/i);
  });

  it("still 500s a genuine server error", async () => {
    // The fix must not turn every unhandled error into a client fault.
    const res = await request(app()).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });

  it("still maps domain errors ahead of the body-parser branch", async () => {
    const res = await request(app()).get("/domain");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad input" });
  });

  it("ignores a non-body-parser error that happens to carry a status", async () => {
    // Only errors with a KNOWN body-parser `type` are honoured — `status` alone
    // is too loose a signal to trust on an arbitrary thrown value.
    const a = express();
    a.get("/rogue", () => {
      throw Object.assign(new Error("nope"), { status: 418, type: "not.a.body.parser.type" });
    });
    a.use(errorHandler);

    const res = await request(a).get("/rogue");

    expect(res.status).toBe(500);
  });
});
