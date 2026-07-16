import { describe, expect, it } from "vitest";
import { MemoryTierStore } from "../../src/shared/store/tier-store";

/**
 * The tier catalog behavior. MemoryTierStore mirrors PgTierStore's CRUD/clone/
 * seed semantics, so the catalog rules (seeded tiers, unlimited⟺no-limit, clone,
 * search, assigned counts) are proven here without a database.
 */

const ADMIN = "root";

describe("MemoryTierStore — seed", () => {
  it("seeds Free (default), Professional, Enterprise", async () => {
    const tiers = await new MemoryTierStore().list();
    expect(tiers.map((t) => t.name)).toEqual(["Free", "Professional", "Enterprise"]);
    const free = tiers.find((t) => t.name === "Free")!;
    expect(free).toMatchObject({ isDefault: true, scanLimit: 30, validityDays: null });
    const ent = tiers.find((t) => t.name === "Enterprise")!;
    expect(ent).toMatchObject({ isUnlimited: true, scanLimit: null, validityDays: 365 });
  });

  it("getDefault returns the Free tier", async () => {
    expect((await new MemoryTierStore().getDefault())?.name).toBe("Free");
  });
});

describe("MemoryTierStore — create", () => {
  it("nulls scanLimit for an unlimited tier", async () => {
    const store = new MemoryTierStore(false);
    const tier = await store.create({
      name: "Trial",
      isUnlimited: true,
      scanLimit: 999, // ignored
      validityDays: 7,
      updatedBy: ADMIN,
    });
    expect(tier.isUnlimited).toBe(true);
    expect(tier.scanLimit).toBeNull();
  });

  it("rejects a duplicate name", async () => {
    const store = new MemoryTierStore();
    await expect(
      store.create({ name: "Free", isUnlimited: false, scanLimit: 5, validityDays: null, updatedBy: ADMIN })
    ).rejects.toThrow(/duplicate/);
  });
});

describe("MemoryTierStore — update", () => {
  it("switching to unlimited clears the scan limit", async () => {
    const store = new MemoryTierStore();
    const pro = (await store.list()).find((t) => t.name === "Professional")!;
    const updated = await store.update(pro.id, { isUnlimited: true }, ADMIN);
    expect(updated?.isUnlimited).toBe(true);
    expect(updated?.scanLimit).toBeNull();
  });

  it("updates the scan limit of a limited tier", async () => {
    const store = new MemoryTierStore();
    const pro = (await store.list()).find((t) => t.name === "Professional")!;
    const updated = await store.update(pro.id, { scanLimit: 1500 }, ADMIN);
    expect(updated?.scanLimit).toBe(1500);
  });
});

describe("MemoryTierStore — clone", () => {
  it("copies all config into a new named row", async () => {
    const store = new MemoryTierStore();
    const pro = (await store.list()).find((t) => t.name === "Professional")!;
    const clone = await store.clone(pro.id, "Professional 2026", ADMIN);
    expect(clone).toMatchObject({
      name: "Professional 2026",
      isUnlimited: pro.isUnlimited,
      scanLimit: pro.scanLimit,
      validityDays: pro.validityDays,
    });
    expect(clone!.id).not.toBe(pro.id);
  });
});

describe("MemoryTierStore — archive & search", () => {
  it("archived tiers drop out of the default listing", async () => {
    const store = new MemoryTierStore();
    const ent = (await store.list()).find((t) => t.name === "Enterprise")!;
    await store.archive(ent.id);
    const active = await store.list();
    expect(active.find((t) => t.name === "Enterprise")).toBeUndefined();
    const all = await store.list({ includeArchived: true });
    expect(all.find((t) => t.name === "Enterprise")).toBeDefined();
  });

  it("search filters by name (case-insensitive)", async () => {
    const store = new MemoryTierStore();
    const found = await store.list({ search: "pro" });
    expect(found.map((t) => t.name)).toEqual(["Professional"]);
  });
});

describe("MemoryTierStore — assigned counts", () => {
  it("reports counts from the injected provider", async () => {
    const store = new MemoryTierStore();
    const pro = (await store.list()).find((t) => t.name === "Professional")!;
    store._setCountsProvider(() => new Map([[pro.id, 128]]));
    const tiers = await store.list();
    expect(tiers.find((t) => t.id === pro.id)?.assignedCount).toBe(128);
  });
});
