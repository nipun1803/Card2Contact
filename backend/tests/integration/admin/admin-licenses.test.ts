import bcrypt from "bcrypt";
import request from "supertest";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(() => ({
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth?mock"),
    setCredentials: vi.fn(),
    getToken: vi.fn(),
    verifyIdToken: vi.fn(),
  })),
}));
vi.mock("googleapis", () => ({ google: { sheets: vi.fn(), drive: vi.fn() } }));

import { createApp } from "../../../src/app";
import { MemoryAuditLogger } from "../../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";
import { InMemoryAdminSessionStore } from "../../../src/shared/store/admin-session-store";
import {
  makeLicenseSettingsStore,
  makeQuotaStore,
  makeSessionStore,
  makeTierStore,
  makeUserStore,
} from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";

const USERNAME = "admin";
const PASSWORD = "correct-horse-battery-staple";
const USER = "u1";

const ENV = { ...process.env };
const open: InMemoryAdminSessionStore[] = [];

function ctx() {
  const adminSessionStore = new InMemoryAdminSessionStore();
  open.push(adminSessionStore);
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const quotaStore = makeQuotaStore();
  const licenseSettingsStore = makeLicenseSettingsStore({ defaultFreeLimit: 10 });
  const tierStore = makeTierStore(quotaStore);
  const userStore = makeUserStore({ findById: vi.fn(async () => makeUser({ googleUserId: USER })) });
  const sessionStore = makeSessionStore();
  const app = createApp({
    userStore,
    sessionStore,
    quotaStore,
    licenseSettingsStore,
    tierStore,
    audit,
    metrics,
    adminSessionStore,
  });
  return { app, quotaStore, licenseSettingsStore, tierStore, userStore };
}

async function adminLogin(app: Express): Promise<string> {
  const res = await request(app)
    .post("/api/admin/auth/login")
    .send({ username: USERNAME, password: PASSWORD });
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  return setCookie[0].split(";")[0];
}

beforeEach(() => {
  process.env.ADMIN_USERNAME = USERNAME;
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
});

afterEach(() => {
  process.env = { ...ENV };
  while (open.length) open.pop()?.stop();
  vi.clearAllMocks();
});

describe("admin-licenses — auth gate", () => {
  it("L1: 401s every route without an admin session", async () => {
    const { app } = ctx();
    expect((await request(app).get("/api/admin/licenses/settings")).status).toBe(401);
    expect((await request(app).get("/api/admin/licenses/quotas")).status).toBe(401);
    expect(
      (await request(app).post(`/api/admin/licenses/quotas/${USER}/scan-block`)).status
    ).toBe(401);
  });
});

describe("admin-licenses — settings", () => {
  it("L2: GET returns the enveloped settings; PATCH updates them", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const get = await request(app).get("/api/admin/licenses/settings").set("Cookie", admin);
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ defaultFreeLimit: 10, enforcementEnabled: true });

    const patch = await request(app)
      .patch("/api/admin/licenses/settings")
      .set("Cookie", admin)
      .send({ defaultFreeLimit: 25, enforcementEnabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ defaultFreeLimit: 25, enforcementEnabled: false });
  });
});

describe("admin-licenses — quota CRUD effects", () => {
  it("L3: set free override, then GET reflects the new remaining", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const put = await request(app)
      .put(`/api/admin/licenses/quotas/${USER}/free`)
      .set("Cookie", admin)
      .send({ limit: 3 });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ freeLimit: 3, hasFreeOverride: true, freeRemaining: 3 });

    const get = await request(app)
      .get(`/api/admin/licenses/quotas/${USER}`)
      .set("Cookie", admin);
    expect(get.body.data.freeLimit).toBe(3);
    // The admin surface labels the row with the user's email for display.
    expect(get.body.data.email).toBe("ada@analyticalengines.com");
  });

  it("L4: remove free override resets to the global default", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    await request(app)
      .put(`/api/admin/licenses/quotas/${USER}/free`)
      .set("Cookie", admin)
      .send({ limit: 3 });
    const del = await request(app)
      .delete(`/api/admin/licenses/quotas/${USER}/free`)
      .set("Cookie", admin);
    expect(del.body.data).toMatchObject({ freeLimit: 10, hasFreeOverride: false });
  });

  it("L5: grant paid returns 201 and shows an active grant; history records it", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const grant = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/paid/grants`)
      .set("Cookie", admin)
      .send({ amount: 5, reason: "trial" });
    expect(grant.status).toBe(201);
    expect(grant.body.data.paidRemaining).toBe(5);
    expect(grant.body.data.paidGrants[0]).toMatchObject({ amount: 5, status: "active" });

    const history = await request(app)
      .get(`/api/admin/licenses/quotas/${USER}/history`)
      .set("Cookie", admin);
    expect(history.body.data.entries[0]).toMatchObject({ kind: "grant", pool: "paid" });
  });

  it("L6: scan-block then scan-unblock flips the flag", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const block = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/scan-block`)
      .set("Cookie", admin);
    expect(block.body.data.scanBlocked).toBe(true);

    const unblock = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/scan-unblock`)
      .set("Cookie", admin);
    expect(unblock.body.data.scanBlocked).toBe(false);
  });
});

describe("admin-licenses — error codes", () => {
  it("L7: 404 LICENSE_USER_NOT_FOUND for an unknown user", async () => {
    const { app, userStore } = ctx();
    (userStore.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const admin = await adminLogin(app);
    const res = await request(app).get(`/api/admin/licenses/quotas/ghost`).set("Cookie", admin);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("LICENSE_USER_NOT_FOUND");
  });

  it("L8: 400 LICENSE_INVALID for a non-positive grant amount", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const res = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/paid/grants`)
      .set("Cookie", admin)
      .send({ amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LICENSE_INVALID");
  });
});

describe("admin-licenses — tiers", () => {
  async function proTierId(app: Express, admin: string): Promise<number> {
    const list = await request(app).get("/api/admin/licenses/tiers").set("Cookie", admin);
    return list.body.data.tiers.find((t: { name: string }) => t.name === "Professional").id;
  }

  it("L9: GET /tiers returns the seeded catalog with assigned counts", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const res = await request(app).get("/api/admin/licenses/tiers").set("Cookie", admin);
    expect(res.status).toBe(200);
    const names = res.body.data.tiers.map((t: { name: string }) => t.name);
    expect(names).toEqual(["Free", "Professional", "Enterprise"]);
    expect(res.body.data.tiers[0]).toHaveProperty("assignedCount");
  });

  it("L10: create → clone → archive a tier", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);

    const created = await request(app)
      .post("/api/admin/licenses/tiers")
      .set("Cookie", admin)
      .send({ name: "Starter", isUnlimited: false, scanLimit: 100, validityDays: 30 });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const clone = await request(app)
      .post(`/api/admin/licenses/tiers/${id}/clone`)
      .set("Cookie", admin)
      .send({ name: "Starter 2026" });
    expect(clone.status).toBe(201);
    expect(clone.body.data.name).toBe("Starter 2026");

    const archive = await request(app)
      .delete(`/api/admin/licenses/tiers/${id}`)
      .set("Cookie", admin);
    expect(archive.status).toBe(204);
  });

  it("L11: 400 when archiving the default (Free) tier", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const list = await request(app).get("/api/admin/licenses/tiers").set("Cookie", admin);
    const free = list.body.data.tiers.find((t: { name: string }) => t.name === "Free");
    const res = await request(app)
      .delete(`/api/admin/licenses/tiers/${free.id}`)
      .set("Cookie", admin);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LICENSE_INVALID");
  });

  it("L12: assign a tier → the quota shows the active tier", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const id = await proTierId(app, admin);
    const res = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/tier`)
      .set("Cookie", admin)
      .send({ tierId: id });
    expect(res.status).toBe(200);
    expect(res.body.data.activeTier.name).toBe("Professional");
  });

  it("L13: assign an unlimited tier → quota is unlimited", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const list = await request(app).get("/api/admin/licenses/tiers").set("Cookie", admin);
    const ent = list.body.data.tiers.find((t: { name: string }) => t.name === "Enterprise");
    const res = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/tier`)
      .set("Cookie", admin)
      .send({ tierId: ent.id });
    expect(res.body.data.unlimited).toBe(true);
  });

  it("L14: tier-history records the assignment", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const id = await proTierId(app, admin);
    await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/tier`)
      .set("Cookie", admin)
      .send({ tierId: id });
    const history = await request(app)
      .get(`/api/admin/licenses/quotas/${USER}/tier-history`)
      .set("Cookie", admin);
    expect(history.body.data.entries[0]).toMatchObject({ tierName: "Professional", action: "assigned" });
  });

  it("L15: 404 TIER_NOT_FOUND for an unknown tier assignment", async () => {
    const { app } = ctx();
    const admin = await adminLogin(app);
    const res = await request(app)
      .post(`/api/admin/licenses/quotas/${USER}/tier`)
      .set("Cookie", admin)
      .send({ tierId: 99999 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TIER_NOT_FOUND");
  });
});
