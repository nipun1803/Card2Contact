import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMetrics, StdoutMetrics, counterKey } from "./metrics";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("counterKey", () => {
  it("returns the bare name when there are no labels", () => {
    expect(counterKey("login_success")).toBe("login_success");
    expect(counterKey("login_success", {})).toBe("login_success");
  });

  it("appends labels", () => {
    expect(counterKey("sheet_recreated", { reason: "trashed" })).toBe(
      "sheet_recreated{reason=trashed}"
    );
  });

  // Otherwise the same logical counter would split in two depending on how the
  // call site happened to order its object literal.
  it("sorts labels so key identity is independent of property order", () => {
    expect(counterKey("auth_failure", { reason: "x", endpoint: "y" })).toBe(
      counterKey("auth_failure", { endpoint: "y", reason: "x" })
    );
  });
});

describe("StdoutMetrics", () => {
  it("emits a snapshot tagged kind:metrics with accumulated counters", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new StdoutMetrics();
    metrics.inc("login_success");
    metrics.inc("login_success");
    metrics.inc("sheet_recreated", { reason: "trashed" });
    metrics.emit();

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.kind).toBe("metrics");
    expect(line.counters).toEqual({
      login_success: 2,
      "sheet_recreated{reason=trashed}": 1,
    });
  });

  // An idle backend printing zeros every minute forever is noise that trains
  // people to ignore the log.
  it("emits nothing when no counter changed", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new StdoutMetrics();
    metrics.emit();
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits nothing on a second snapshot if nothing changed since the first", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new StdoutMetrics();
    metrics.inc("login_success");
    metrics.emit();
    metrics.emit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("emits again once a counter changes after a snapshot", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new StdoutMetrics();
    metrics.inc("login_success");
    metrics.emit();
    metrics.inc("login_failure", { reason: "bad_code" });
    metrics.emit();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(spy.mock.calls[1][0] as string).counters).toEqual({
      login_success: 1,
      "login_failure{reason=bad_code}": 1,
    });
  });

  it("emits on the timer interval and stops cleanly", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new StdoutMetrics();
    metrics.start(1000);
    metrics.inc("login_success");
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    metrics.stop();
    metrics.inc("login_success");
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("never throws when serialisation fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    const metrics = new StdoutMetrics();
    metrics.inc("login_success");
    expect(() => metrics.emit()).not.toThrow();
  });
});

describe("MemoryMetrics", () => {
  it("counts by name and labels", () => {
    const metrics = new MemoryMetrics();
    metrics.inc("session_revoked", { reason: "logout" });
    metrics.inc("session_revoked", { reason: "logout" });
    metrics.inc("session_revoked", { reason: "replaced_by_new_login" });

    expect(metrics.get("session_revoked", { reason: "logout" })).toBe(2);
    expect(metrics.get("session_revoked", { reason: "replaced_by_new_login" })).toBe(1);
  });

  it("returns 0 for a counter never incremented", () => {
    expect(new MemoryMetrics().get("login_failure")).toBe(0);
  });
});
