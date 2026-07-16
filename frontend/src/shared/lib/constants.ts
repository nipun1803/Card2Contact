/** App-wide constants and route paths. */

export const ROUTES = {
  landing: "/",
  login: "/login",
  dashboard: "/dashboard",
  scan: "/app",
  profile: "/profile",
  /** Session Conflict prompt — the OAuth callback redirects here when the user
   *  already has an Active Session on another device. */
  sessionConflict: "/session-conflict",
  /** Operator routes. Deliberately outside the Google-session guards — an admin
   *  is a different identity entirely, and may or may not also be a signed-in
   *  user. See src/app/router.tsx and docs/modules/admin/. */
  adminLogin: "/admin/login",
  adminDashboard: "/admin/dashboard",
  adminUsers: "/admin/users",
} as const;

/** Admin User Management: detail page path for a given user. */
export function adminUserDetailPath(googleUserId: string): string {
  return `/admin/users/${googleUserId}`;
}

/** Default title of the auto-provisioned spreadsheet (backend constant). */
export const SPREADSHEET_TITLE = "Card2Contact Contacts";

/** Largest edge (px) we downscale uploaded card images to before sending. */
export const MAX_IMAGE_EDGE = 2000;

/** How many recent scans to keep in localStorage. */
export const RECENT_SCANS_LIMIT = 10;

/** The four visible pipeline stages shown in the workflow progress strip. */
export const WORKFLOW_STEPS = [
  { key: "capture", label: "Scan / Upload" },
  { key: "extract", label: "Extract" },
  { key: "review", label: "Review" },
  { key: "save", label: "Save" },
] as const;
