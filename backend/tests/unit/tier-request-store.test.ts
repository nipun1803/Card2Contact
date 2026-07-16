import { describe, expect, it } from "vitest";
import {
  MemoryTierRequestStore,
  DuplicatePendingRequestError,
} from "../../src/shared/store/tier-request-store";

/**
 * Tier Upgrade Request store behavior. MemoryTierRequestStore mirrors the Pg
 * semantics that the DB enforces — one pending request per user (partial unique
 * index) and an atomic pending-guarded decide() (no double-grant) — so those
 * invariants are proven here without a database.
 */

const USER = "u1";

function tierReq(googleUserId = USER) {
  return {
    googleUserId,
    kind: "tier" as const,
    requestedTierId: 2,
    requestedTierName: "Professional",
    userNote: null,
    currentTierName: "Free",
  };
}

describe("MemoryTierRequestStore — one pending per user", () => {
  it("creates a pending request", async () => {
    const store = new MemoryTierRequestStore();
    const r = await store.create(tierReq());
    expect(r).toMatchObject({ status: "pending", kind: "tier", requestedTierName: "Professional" });
  });

  it("rejects a second pending request from the same user", async () => {
    const store = new MemoryTierRequestStore();
    await store.create(tierReq());
    await expect(store.create(tierReq())).rejects.toBeInstanceOf(DuplicatePendingRequestError);
  });

  it("allows a new request once the prior one is decided", async () => {
    const store = new MemoryTierRequestStore();
    const first = await store.create(tierReq());
    await store.decide(first.id, { status: "rejected", decidedBy: "root" });
    // No longer pending → a fresh request is allowed.
    await expect(store.create(tierReq())).resolves.toMatchObject({ status: "pending" });
  });

  it("scopes the pending rule per user", async () => {
    const store = new MemoryTierRequestStore();
    await store.create(tierReq("u1"));
    await expect(store.create(tierReq("u2"))).resolves.toMatchObject({ status: "pending" });
  });
});

describe("MemoryTierRequestStore — decide (atomic, idempotent)", () => {
  it("records an approval with the granted values", async () => {
    const store = new MemoryTierRequestStore();
    const r = await store.create(tierReq());
    const decided = await store.decide(r.id, {
      status: "approved",
      decidedBy: "root",
      grantedTierId: 2,
    });
    expect(decided).toMatchObject({ status: "approved", decidedBy: "root", grantedTierId: 2 });
    expect(decided?.decidedAt).not.toBeNull();
  });

  it("a second decide is a no-op (returns null — no double-grant)", async () => {
    const store = new MemoryTierRequestStore();
    const r = await store.create(tierReq());
    await store.decide(r.id, { status: "approved", decidedBy: "root", grantedTierId: 2 });
    const second = await store.decide(r.id, { status: "approved", decidedBy: "root", grantedTierId: 2 });
    expect(second).toBeNull();
  });

  it("returns null for an unknown request id", async () => {
    const store = new MemoryTierRequestStore();
    expect(await store.decide(999, { status: "rejected", decidedBy: "root" })).toBeNull();
  });

  it("records a rejection reason", async () => {
    const store = new MemoryTierRequestStore();
    const r = await store.create(tierReq());
    const decided = await store.decide(r.id, {
      status: "rejected",
      decidedBy: "root",
      decisionNote: "contact sales",
    });
    expect(decided).toMatchObject({ status: "rejected", decisionNote: "contact sales" });
  });
});

describe("MemoryTierRequestStore — queries", () => {
  it("pendingForUser returns only the open request", async () => {
    const store = new MemoryTierRequestStore();
    const r = await store.create(tierReq());
    expect((await store.pendingForUser(USER))?.id).toBe(r.id);
    await store.decide(r.id, { status: "approved", decidedBy: "root", grantedTierId: 2 });
    expect(await store.pendingForUser(USER)).toBeNull();
  });

  it("pendingCount counts only pending across users", async () => {
    const store = new MemoryTierRequestStore();
    const a = await store.create(tierReq("u1"));
    await store.create(tierReq("u2"));
    expect(await store.pendingCount()).toBe(2);
    await store.decide(a.id, { status: "approved", decidedBy: "root", grantedTierId: 2 });
    expect(await store.pendingCount()).toBe(1);
  });

  it("list filters by status and reports pendingCount", async () => {
    const store = new MemoryTierRequestStore();
    const a = await store.create(tierReq("u1"));
    await store.create(tierReq("u2"));
    await store.decide(a.id, { status: "rejected", decidedBy: "root" });
    const pending = await store.list({ status: "pending" });
    expect(pending.requests).toHaveLength(1);
    expect(pending.pendingCount).toBe(1);
    const rejected = await store.list({ status: "rejected" });
    expect(rejected.requests).toHaveLength(1);
  });

  it("listForUser returns a user's requests newest-first", async () => {
    const store = new MemoryTierRequestStore();
    const first = await store.create(tierReq());
    await store.decide(first.id, { status: "rejected", decidedBy: "root" });
    const second = await store.create(tierReq());
    const list = await store.listForUser(USER);
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
  });
});
