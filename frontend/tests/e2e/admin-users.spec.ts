import { expect, test } from "@playwright/test";
import { mockBackend, type MockAdminUser } from "./mockApi";

/**
 * Admin User Management (Phase 1), in a real browser, through nginx.
 *
 * Like admin.spec.ts, real Google OAuth can't run here — the backend is
 * mocked at the network boundary (see mockApi.ts's adminUsers option), and
 * the React app is unchanged and unaware.
 */

const USERS: MockAdminUser[] = [
  {
    googleUserId: "u1",
    email: "ada@analyticalengines.com",
    savedContactsCount: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: "2026-07-15T00:00:00.000Z",
    activeSession: { device: "macOS", browser: "Chrome", ip: "203.0.113.1", lastActivityAt: "2026-07-16T08:00:00.000Z" },
  },
  {
    googleUserId: "u2",
    email: "grace@example.com",
    savedContactsCount: 0,
    createdAt: "2026-02-01T00:00:00.000Z",
    disabled: true,
    disabledAt: "2026-06-01T00:00:00.000Z",
    disabledBy: "admin",
  },
];

test.describe("User Directory", () => {
  test("renders with seeded users and summary stats", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });

    await page.goto("/admin/users");

    await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
    await expect(page.getByText("ada@analyticalengines.com")).toBeVisible();
    await expect(page.getByText("grace@example.com")).toBeVisible();
    await expect(page.getByText("Total Users")).toBeVisible();
    // App-wide scans stat: sum of both seeded users' savedContactsCount (5 + 0).
    // "Total Scans" labels both the stat card and the table column — scope to
    // the stat card via its distinctive icon+label+value layout.
    const scansCard = page.locator(".flex.items-center.gap-4").filter({ hasText: "Total Scans" });
    await expect(scansCard).toBeVisible();
    await expect(scansCard.getByText("5", { exact: true })).toBeVisible();
    // The directory never uses the legacy "saved contacts" wording.
    await expect(page.getByText(/saved contacts/i)).toHaveCount(0);
  });

  test("search filters the list", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users");
    await expect(page.getByText("grace@example.com")).toBeVisible();

    await page.getByPlaceholder(/search by email/i).fill("ada");

    await expect(page.getByText("ada@analyticalengines.com")).toBeVisible();
    await expect(page.getByText("grace@example.com")).not.toBeVisible();
  });

  test("status filter narrows to revoked users only", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users");

    await page.getByRole("combobox").selectOption("disabled");

    await expect(page.getByText("grace@example.com")).toBeVisible();
    await expect(page.getByText("ada@analyticalengines.com")).not.toBeVisible();
  });

  test("clicking a row navigates to the user's detail page", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users");

    await page.getByRole("link", { name: "View" }).first().click();

    await expect(page).toHaveURL(/\/admin\/users\/u1$/);
    await expect(page.getByRole("heading", { name: "ada@analyticalengines.com" })).toBeVisible();
  });

  test("is usable on a mobile viewport with no horizontal scroll", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto("/admin/users");

    await expect(page.getByRole("heading", { name: "User Directory" })).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test.describe("User Details — account management", () => {
  test("shows profile, session, and audit sections", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });

    await page.goto("/admin/users/u1");

    await expect(page.getByRole("heading", { name: "ada@analyticalengines.com" })).toBeVisible();
    await expect(page.getByText("macOS")).toBeVisible();
    await expect(page.getByText("No audit history")).toBeVisible();
    // Profile shows the user's own scan count, labeled "Total scans" (not
    // "Saved contacts"), and never links out to their spreadsheet.
    await expect(page.getByText("Total scans")).toBeVisible();
    await expect(page.getByText(/saved contacts/i)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /open in google sheets/i })).toHaveCount(0);
  });

  test("Revoke Access flips the status badge to Revoked", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users/u1");

    await page.getByRole("button", { name: /revoke access/i }).click();
    // Confirm within the dialog.
    await page.getByRole("dialog").getByRole("button", { name: /revoke access/i }).click();

    // "Revoked" also appears in the "Revoked at"/"Revoked by" row labels once
    // disabled, so scope to the status badge (exact match, no "at"/"by" suffix).
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /restore access/i })).toBeVisible();
  });

  test("Restore Access flips it back to Active", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users/u2"); // pre-seeded as disabled

    await page.getByRole("button", { name: /restore access/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /restore access/i }).click();

    await expect(page.getByRole("button", { name: /revoke access/i })).toBeVisible();
  });

  test("Force Logout succeeds without changing the status badge", async ({ page }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users/u1");

    await page.getByRole("button", { name: /force logout/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /force logout/i }).click();

    await expect(page.getByText("No active session.")).toBeVisible();
    // Status is unaffected by a force logout — only the session ends.
    await expect(page.locator("body")).not.toContainText("Revoked");
  });

  test("Force Logout shows up in Audit History immediately — not a no-op-looking dead button", async ({
    page,
  }) => {
    await mockBackend(page, { adminAuthenticated: true, adminUsers: USERS });
    await page.goto("/admin/users/u1");

    await expect(page.getByText("No audit history")).toBeVisible();

    await page.getByRole("button", { name: /force logout/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /force logout/i }).click();

    // The whole point of this test: without invalidating the audit query,
    // this panel kept showing "No audit history" forever after a successful
    // action, which is what made Force Logout look like it did nothing.
    await expect(page.getByText("Session force-ended by admin")).toBeVisible();
    await expect(page.getByText("No audit history")).not.toBeVisible();
  });

  test("Force Logout failure keeps the dialog open and shows the error", async ({ page }) => {
    await mockBackend(page, {
      adminAuthenticated: true,
      adminUsers: USERS,
      adminForceLogoutFails: true,
    });
    await page.goto("/admin/users/u1");

    await page.getByRole("button", { name: /force logout/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /force logout/i }).click();

    // The admin sees why it failed instead of the dialog silently sitting
    // there or vanishing with no feedback (see the earlier reported bug).
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    // The session is unaffected by the failed attempt.
    await page.getByRole("dialog").getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByText("macOS")).toBeVisible();
  });
});
