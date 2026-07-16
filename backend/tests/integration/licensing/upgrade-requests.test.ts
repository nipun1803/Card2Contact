import bcrypt from "bcrypt";
import request from "supertest";
import type { Express } from "express";
import { createHmac } from "node:crypto";
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
  makeTierRequestStore,
  makeUserStore,
} from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";

/**
 * End-to-end Tier Upgrade Request flow across BOTH auth surfaces on one app with
 * shared stores: the user (Google session) files a request at /api/me, the admin
 * (Admin Session) sees it in the queue and approves it, and the user's plan then
 * reflects the granted tier. Proves the request layer routes an approval through
 * the standard assignTier seam — the single source of truth.
 */

const USERNAME = "admin";
const PASSWORD = "correct-horse-battery-staple";
const USER = "u1";
const COOKIE_NAME = "c2c_session";

const ENV = { ...process.env };
const open: InMemoryAdminSessionStore[] = [];

function ctx() {
  const adminSessionStore = new InMemoryAdminSessionStore();
  open.push(adminSessionStore);
  const quotaStore = makeQuotaStore();
  const licenseSettingsStore = makeLicenseSettingsStore({ defaultFreeLimit: 5 });
  const tierStore = makeTierStore(quotaStore);
  const tierRequestStore = makeTierRequestStore();
  const sessionStore = makeSessionStore();
  const userStore = makeUserStore({ findById: async () => makeUser({ googleUserId: USER }) });
  const app = createApp({
    userStore,
    sessionStore,
    quotaStore,
    licenseSettingsStore,
    tierStore,
    tierRequestStore,
    audit: new MemoryAuditLogger(),
    metrics: new MemoryMetrics(),
    adminSessionStore,
  });

  // Sign a user session cookie the way the server expects (see helpers/app.ts).
  const session = sessionStore._seed({ googleUserId: USER });
  const secret = process.env.SESSION_SECRET!;
  const sig = createHmac("sha256", secret).update(session.id).digest("base64").replace(/=+$/, "");
  const userCookie = `${COOKIE_NAME}=${encodeURIComponent(`s:${session.id}.${sig}`)}`;

  return { app, userCookie, quotaStore, tierStore };
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

describe("upgrade requests — user surface (/api/me)", () => {
  it("R1: requires auth", async () => {
    const { app } = ctx();
    expect((await request(app).get("/api/me/plan")).status).toBe(401);
    expect((await request(app).post("/api/me/requests").send({ kind: "tier" })).status).toBe(401);
  });

  it("R2: GET /me/plan returns quota + catalog + empty request state", async () => {
    const { app, userCookie } = ctx();
    const res = await request(app).get("/api/me/plan").set("Cookie", userCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.quota.freeLimit).toBe(5);
    expect(res.body.data.availableTiers.map((t: { name: string }) => t.name)).toContain("Professional");
    expect(res.body.data.pendingRequest).toBeNull();
  });

  it("R3: file a tier request → it shows as pending; a second is 409", async () => {
    const { app, userCookie, tierStore } = ctx();
    const pro = (await tierStore.list()).find((t) => t.name === "Professional")!;

    const created = await request(app)
      .post("/api/me/requests")
      .set("Cookie", userCookie)
      .send({ kind: "tier", tierId: pro.id, note: "need more" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ kind: "tier", status: "pending" });

    const plan = await request(app).get("/api/me/plan").set("Cookie", userCookie);
    expect(plan.body.data.pendingRequest?.requestedTierName).toBe("Professional");

    // One pending per user — a second request conflicts.
    const dup = await request(app)
      .post("/api/me/requests")
      .set("Cookie", userCookie)
      .send({ kind: "tier", tierId: pro.id });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("REQUEST_ALREADY_PENDING");
  });

  it("R4: a custom request without a reason is 400 REQUEST_INVALID", async () => {
    const { app, userCookie } = ctx();
    const res = await request(app)
      .post("/api/me/requests")
      .set("Cookie", userCookie)
      .send({ kind: "custom", amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REQUEST_INVALID");
  });
});

describe("upgrade requests — admin approval flow", () => {
  it("R5: user files → admin queue shows it → approve grants the tier → user's plan reflects it", async () => {
    const { app, userCookie, tierStore } = ctx();
    const admin = await adminLogin(app);
    const pro = (await tierStore.list()).find((t) => t.name === "Professional")!;

    // User files.
    const created = await request(app)
      .post("/api/me/requests")
      .set("Cookie", userCookie)
      .send({ kind: "tier", tierId: pro.id });
    const requestId = created.body.data.id;

    // Admin queue shows one pending; badge count is 1.
    const queue = await request(app)
      .get("/api/admin/licenses/requests?status=pending")
      .set("Cookie", admin);
    expect(queue.status).toBe(200);
    expect(queue.body.data.requests).toHaveLength(1);
    expect(queue.body.data.pendingCount).toBe(1);

    const count = await request(app).get("/api/admin/licenses/requests/count").set("Cookie", admin);
    expect(count.body.data.pendingCount).toBe(1);

    // Admin approves as asked.
    const approve = await request(app)
      .post(`/api/admin/licenses/requests/${requestId}/approve`)
      .set("Cookie", admin)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.request.status).toBe("approved");
    expect(approve.body.data.quota.activeTier?.name).toBe("Professional");

    // The user's own plan now reflects the grant, and no request is pending.
    const plan = await request(app).get("/api/me/plan").set("Cookie", userCookie);
    expect(plan.body.data.quota.activeTier?.name).toBe("Professional");
    expect(plan.body.data.pendingRequest).toBeNull();

    // The badge is back to zero.
    const after = await request(app).get("/api/admin/licenses/requests/count").set("Cookie", admin);
    expect(after.body.data.pendingCount).toBe(0);
  });

  it("R6: admin rejects with a reason; the user sees it and no grant lands", async () => {
    const { app, userCookie, tierStore } = ctx();
    const admin = await adminLogin(app);
    const pro = (await tierStore.list()).find((t) => t.name === "Professional")!;

    const created = await request(app)
      .post("/api/me/requests")
      .set("Cookie", userCookie)
      .send({ kind: "tier", tierId: pro.id });

    const reject = await request(app)
      .post(`/api/admin/licenses/requests/${created.body.data.id}/reject`)
      .set("Cookie", admin)
      .send({ note: "Contact sales for Enterprise" });
    expect(reject.status).toBe(200);
    expect(reject.body.data).toMatchObject({ status: "rejected", decisionNote: "Contact sales for Enterprise" });

    const plan = await request(app).get("/api/me/plan").set("Cookie", userCookie);
    expect(plan.body.data.quota.activeTier).toBeNull();
    // The user can now re-request (the pending lock is released).
    const again = await request(app)
      .post("/api/me/requests")
      .set("Cookie", userCookie)
      .send({ kind: "tier", tierId: pro.id });
    expect(again.status).toBe(201);
  });

  it("R7: the admin request routes require an admin session", async () => {
    const { app } = ctx();
    expect((await request(app).get("/api/admin/licenses/requests")).status).toBe(401);
    expect((await request(app).post("/api/admin/licenses/requests/1/approve").send({})).status).toBe(401);
  });
});
