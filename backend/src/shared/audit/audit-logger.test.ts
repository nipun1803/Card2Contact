import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditLogger, StdoutAuditLogger } from "./audit-logger";

/** Capture console.log and parse the emitted JSON line. */
function captureLine(run: (logger: StdoutAuditLogger) => void): Record<string, unknown> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  run(new StdoutAuditLogger());
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0][0] as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StdoutAuditLogger", () => {
  it("emits a single line of JSON tagged kind:audit with a timestamp", () => {
    const line = captureLine((l) => l.log({ event: "login", googleUserId: "u1" }));
    expect(line.kind).toBe("audit");
    expect(line.event).toBe("login");
    expect(line.googleUserId).toBe("u1");
    expect(typeof line.ts).toBe("string");
    expect(new Date(line.ts as string).toString()).not.toBe("Invalid Date");
  });

  // The single most important behaviour here: a full session id in the logs is
  // a live credential. Truncation lives at the sink so no call site can leak
  // one by forgetting to slice.
  it("truncates sessionId to 8 characters", () => {
    const full = "k3Jd8fQzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const line = captureLine((l) => l.log({ event: "login", sessionId: full }));
    expect(line.sessionId).toBe("k3Jd8fQz");
    expect(JSON.stringify(line)).not.toContain(full);
  });

  it("omits sessionId entirely when absent or null", () => {
    expect(captureLine((l) => l.log({ event: "login" }))).not.toHaveProperty("sessionId");
    expect(
      captureLine((l) => l.log({ event: "login", sessionId: null }))
    ).not.toHaveProperty("sessionId");
  });

  it("preserves the fields an investigation needs", () => {
    const line = captureLine((l) =>
      l.log({
        event: "session_replaced",
        googleUserId: "u1",
        device: "iPhone",
        browser: "Safari",
        ip: "203.0.113.4",
        reason: "replaced_by_new_login",
        revokedCount: 1,
      })
    );
    expect(line).toMatchObject({
      event: "session_replaced",
      googleUserId: "u1",
      device: "iPhone",
      browser: "Safari",
      ip: "203.0.113.4",
      reason: "replaced_by_new_login",
      revokedCount: 1,
    });
  });

  it("never throws when serialisation fails", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    const logger = new StdoutAuditLogger();
    expect(() => logger.log({ event: "login" })).not.toThrow();
    spy.mockRestore();
  });
});

describe("MemoryAuditLogger", () => {
  it("captures entries in order", () => {
    const logger = new MemoryAuditLogger();
    logger.log({ event: "login", googleUserId: "u1" });
    logger.log({ event: "logout", googleUserId: "u1" });
    expect(logger.entries.map((e) => e.event)).toEqual(["login", "logout"]);
  });

  it("filters by event type", () => {
    const logger = new MemoryAuditLogger();
    logger.log({ event: "login", googleUserId: "u1" });
    logger.log({ event: "auth_failure", reason: "session_revoked" });
    logger.log({ event: "login", googleUserId: "u2" });
    expect(logger.ofType("login")).toHaveLength(2);
    expect(logger.ofType("auth_failure")).toHaveLength(1);
  });

  // Unlike the stdout sink, the test double keeps the full id so integration
  // tests can correlate against the cookie they were handed.
  it("keeps sessionId untruncated for test assertions", () => {
    const logger = new MemoryAuditLogger();
    logger.log({ event: "login", sessionId: "full-session-id-value" });
    expect(logger.entries[0].sessionId).toBe("full-session-id-value");
  });
});
