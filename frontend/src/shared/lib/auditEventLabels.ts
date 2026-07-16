/**
 * Human-readable labels for backend AuditEvent names, shown in the admin User
 * Details "Audit History" panel. Falls back to the raw event name for any
 * event not listed here (e.g. a future addition), so the UI never renders
 * blank.
 */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  oauth_reconnect: "Reconnected Google",
  contact_save: "Saved a contact",
  auth_failure: "Sign-in failed",
  session_created: "Session created",
  session_terminated: "Session ended",
  session_replaced: "Signed in on another device",
  session_conflict: "Session conflict detected",
  session_conflict_cancelled: "Session conflict cancelled",
  sheet_recreated: "Spreadsheet recreated",
  token_refresh_failed: "Token refresh failed",
  admin_user_disabled: "Access revoked by admin",
  admin_user_restored: "Access restored by admin",
  admin_user_sessions_revoked: "Session force-ended by admin",
};
