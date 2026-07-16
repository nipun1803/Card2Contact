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

/**
 * Admin auth through nginx, against the REAL backend (no mocks).
 *
 * The point is the proxy path: nginx matches `location /api/` by prefix, so
 * /api/admin/* should reach the backend like any other route. If it ever didn't,
 * these would come back as nginx's HTML 404 rather than the app's JSON — a
 * failure mode no unit or mocked test can see.
 *
 * These assert the CONTRACT SHAPE, not a specific auth outcome: the CI stack
 * runs without ADMIN_* set, so the admin panel is disabled and answers 503,
 * while a local stack with credentials configured answers 401. Both are correct;
 * both are JSON from Express with a machine-readable code.
 */
test.describe("admin auth API through nginx", () => {
  test("GET /api/admin/auth/me returns JSON from the app, not an nginx error page", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/auth/me");

    // 401 when admin is configured, 503 when it is not — never a 404, which
    // would mean nginx never routed it.
    expect([401, 503]).toContain(res.status());
    expect(res.headers()["content-type"]).toContain("application/json");
    const body = await res.json();
    expect(body.code).toMatch(/^ADMIN_(NOT_AUTHENTICATED|NOT_CONFIGURED)$/);
  });

  test("POST /api/admin/auth/login is reachable and never leaks which credential was wrong", async ({
    request,
  }) => {
    const res = await request.post("/api/admin/auth/login", {
      data: { username: "definitely-not-the-admin", password: "definitely-not-the-password" },
    });

    expect([401, 503]).toContain(res.status());
    const body = await res.json();
    // Whatever the outcome, the body must never hint at WHICH field was wrong.
    expect(JSON.stringify(body)).not.toMatch(/username|password/i);
  });

  test("POST /api/admin/auth/logout is idempotent with no session", async ({ request }) => {
    const res = await request.post("/api/admin/auth/logout");

    // 200 {ok:true} when configured; 503 when the panel is off. Never a 401 —
    // telling someone they cannot log out because they are not logged in is
    // hostile and pointless.
    expect([200, 503]).toContain(res.status());
  });
});
