import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Scan quota enforcement, proven end-to-end over HTTP. This is the composition
 * proof: requireAuth runs before the guard, the guard runs before M2 (so a 402
 * short-circuits before OCR), and the error handler maps QuotaExceededError →
 * 402 / ScanBlockedError → 403. Mistral is mocked; if the guard ever let an
 * exhausted request through, the OCR mock would be called — we assert it isn't.
 */

const ocrProcess = vi.fn(async () => ({ pages: [{ markdown: "Ada Lovelace" }] }));
vi.mock("@mistralai/mistralai", () => ({
  Mistral: vi.fn().mockImplementation(() => ({ ocr: { process: ocrProcess } })),
}));
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/mock"),
    getToken: vi.fn(),
    verifyIdToken: vi.fn(),
    setCredentials: vi.fn(),
    on: vi.fn(),
  })),
}));

import { buildAuthedTestApp } from "../helpers/app";
import { makeLicenseSettingsStore, makeQuotaStore } from "../mocks/stores";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Submit a card as the authed user and return its cardId. */
async function submitCard(app: import("express").Express, cookie: string): Promise<string> {
  const res = await request(app)
    .post("/api/cards")
    .set("Cookie", cookie)
    .field("mode", "single")
    .attach("frontImage", PNG, "card.png");
  return res.body.cardId;
}

beforeEach(() => vi.clearAllMocks());

describe("scan quota enforcement", () => {
  it("allows a scan when quota remains and consumes one unit", async () => {
    const quotaStore = makeQuotaStore();
    const { app, cookie, googleUserId } = buildAuthedTestApp({
      quotaStore,
      licenseSettingsStore: makeLicenseSettingsStore({ defaultFreeLimit: 5 }),
    });
    const cardId = await submitCard(app, cookie);

    const res = await request(app).post(`/api/cards/${cardId}/recognize`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    const eff = await quotaStore.getEffective(googleUserId, {
      defaultFreeLimit: 5,
      defaultPaidLimit: 0,
      freeEnabled: true,
      paidEnabled: true,
      enforcementEnabled: true,
      updatedAt: new Date(),
      updatedBy: null,
    });
    expect(eff.freeUsed).toBe(1);
  });

  it("402 QUOTA_EXCEEDED once exhausted, and never calls OCR", async () => {
    const { app, cookie } = buildAuthedTestApp({
      licenseSettingsStore: makeLicenseSettingsStore({ defaultFreeLimit: 1 }),
    });
    const card1 = await submitCard(app, cookie);
    const card2 = await submitCard(app, cookie);

    const ok = await request(app).post(`/api/cards/${card1}/recognize`).set("Cookie", cookie);
    expect(ok.status).toBe(200);

    ocrProcess.mockClear();
    const blocked = await request(app).post(`/api/cards/${card2}/recognize`).set("Cookie", cookie);
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe("QUOTA_EXCEEDED");
    expect(ocrProcess).not.toHaveBeenCalled(); // short-circuited before Mistral
  });

  it("does not double-consume when the same recognize is retried", async () => {
    const quotaStore = makeQuotaStore();
    const settings = makeLicenseSettingsStore({ defaultFreeLimit: 2 });
    const { app, cookie, googleUserId } = buildAuthedTestApp({ quotaStore, licenseSettingsStore: settings });
    const cardId = await submitCard(app, cookie);

    await request(app).post(`/api/cards/${cardId}/recognize`).set("Cookie", cookie);
    await request(app).post(`/api/cards/${cardId}/recognize`).set("Cookie", cookie); // retry

    const eff = await quotaStore.getEffective(googleUserId, await settings.get());
    expect(eff.freeUsed).toBe(1); // billed once
  });

  it("403 SCAN_BLOCKED for a Scan-Blocked user, even with quota", async () => {
    const quotaStore = makeQuotaStore();
    const { app, cookie, googleUserId } = buildAuthedTestApp({
      quotaStore,
      licenseSettingsStore: makeLicenseSettingsStore({ defaultFreeLimit: 100 }),
    });
    await quotaStore.setScanBlocked(googleUserId, true, "admin");
    const cardId = await submitCard(app, cookie);

    const res = await request(app).post(`/api/cards/${cardId}/recognize`).set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SCAN_BLOCKED");
  });

  it("401s an anonymous M1 upload before any quota is touched", async () => {
    const { app } = buildAuthedTestApp();
    const res = await request(app)
      .post("/api/cards")
      .field("mode", "single")
      .attach("frontImage", PNG, "card.png");
    expect(res.status).toBe(401);
  });

  it("allows over-limit scans when enforcement is disabled", async () => {
    const { app, cookie } = buildAuthedTestApp({
      licenseSettingsStore: makeLicenseSettingsStore({
        defaultFreeLimit: 0,
        enforcementEnabled: false,
      }),
    });
    const cardId = await submitCard(app, cookie);
    const res = await request(app).post(`/api/cards/${cardId}/recognize`).set("Cookie", cookie);
    expect(res.status).toBe(200); // overage allowed
  });

  it("an unlimited-tier user scans past any number with no 402", async () => {
    const quotaStore = makeQuotaStore();
    const { app, cookie, googleUserId } = buildAuthedTestApp({
      quotaStore,
      // Zero free allowance: only the unlimited window lets these through.
      licenseSettingsStore: makeLicenseSettingsStore({ defaultFreeLimit: 0 }),
    });
    // Assign an unlimited window directly (what assignTier does for an unlimited tier).
    await quotaStore.assignTier({
      googleUserId,
      tierId: 3,
      tierName: "Enterprise",
      isUnlimited: true,
      scanLimit: null,
      validityDays: 365,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      adminUsername: "root",
      previousTierId: null,
      previousTierName: null,
    });

    for (let i = 0; i < 5; i++) {
      const cardId = await submitCard(app, cookie);
      const res = await request(app).post(`/api/cards/${cardId}/recognize`).set("Cookie", cookie);
      expect(res.status).toBe(200);
    }
    // No counter moved — unlimited records usage but never draws down.
    const eff = await quotaStore.getEffective(googleUserId, await makeLicenseSettingsStore().get());
    expect(eff.freeUsed).toBe(0);
    expect(eff.unlimited).toBe(true);
  });
});
