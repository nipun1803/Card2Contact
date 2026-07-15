import { describe, expect, it, vi, afterEach } from "vitest";
import { timeAgo, nameFromEmail, initials } from "@/shared/utils/format";

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers());

  function freezeNow(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  it("returns 'just now' under 45s", () => {
    freezeNow("2026-07-14T12:00:30Z");
    expect(timeAgo("2026-07-14T12:00:00Z")).toBe("just now");
  });

  it("returns minutes with correct pluralization", () => {
    freezeNow("2026-07-14T12:05:00Z");
    expect(timeAgo("2026-07-14T12:00:00Z")).toBe("5 mins ago");
    freezeNow("2026-07-14T12:01:00Z");
    expect(timeAgo("2026-07-14T12:00:00Z")).toBe("1 min ago");
  });

  it("returns hours then days", () => {
    freezeNow("2026-07-14T15:00:00Z");
    expect(timeAgo("2026-07-14T12:00:00Z")).toBe("3 hours ago");
    freezeNow("2026-07-17T12:00:00Z");
    expect(timeAgo("2026-07-14T12:00:00Z")).toBe("3 days ago");
  });

  it("returns empty string for an unparseable date", () => {
    expect(timeAgo("not-a-date")).toBe("");
  });
});

describe("nameFromEmail", () => {
  it("capitalizes the first token of the local part", () => {
    expect(nameFromEmail("ada.lovelace@example.com")).toBe("Ada");
    expect(nameFromEmail("grace_hopper@navy.mil")).toBe("Grace");
  });

  it("falls back to 'there' for empty/nullish input", () => {
    expect(nameFromEmail(null)).toBe("there");
    expect(nameFromEmail(undefined)).toBe("there");
    expect(nameFromEmail("")).toBe("there");
  });
});

describe("initials", () => {
  it("uses two name parts when available", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada.lovelace@x.com")).toBe("AL");
  });

  it("falls back to the first two chars for a single token", () => {
    expect(initials("Ada")).toBe("AD");
  });

  it("returns '??' for nullish input", () => {
    expect(initials(null)).toBe("??");
  });
});
