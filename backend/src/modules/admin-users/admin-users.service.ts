import {
  UserStore,
  UserRecord,
  ListUsersParams,
  ListUsersResult,
  UserStats,
} from "../../shared/store/user-store";
import { SessionStore } from "../../shared/store/session-store";
import { AuditLogger, AuditQueryResult } from "../../shared/audit/audit-logger";
import { Metrics } from "../../shared/observability/metrics";

/**
 * Admin User Management business rules. No HTTP here — mirrors
 * AdminAuthService's separation of concerns: the router owns status codes and
 * request parsing, this owns "what does Revoke/Restore/Force-Logout actually
 * do". See docs/modules/admin/USER_MANAGEMENT.md.
 */

export class UserNotFoundError extends Error {
  readonly code = "USER_NOT_FOUND";
  constructor(message = "User not found") {
    super(message);
    this.name = "UserNotFoundError";
  }
}

export interface ActiveSessionInfo {
  device: string | null;
  browser: string | null;
  ip: string | null;
  lastActivityAt: string;
}

export interface AdminUserDetail extends UserRecord {
  activeSession: ActiveSessionInfo | null;
}

/** Device/browser/ip captured from the admin's own request, for audit entries. */
export interface RequestFingerprint {
  device: string | null;
  browser: string | null;
  ip: string | null;
}

export class AdminUserService {
  constructor(
    private readonly users: UserStore,
    private readonly sessions: SessionStore,
    private readonly audit: AuditLogger,
    private readonly metrics: Metrics
  ) {}

  list(params: ListUsersParams): Promise<ListUsersResult> {
    return this.users.list(params);
  }

  stats(): Promise<UserStats> {
    return this.users.stats();
  }

  async getDetail(googleUserId: string): Promise<AdminUserDetail> {
    const user = await this.users.findById(googleUserId);
    if (!user) throw new UserNotFoundError();
    return { ...user, activeSession: await this.loadActiveSession(googleUserId) };
  }

  /**
   * Revoke Access: (a) disable the row, (b) force-revoke any live session, (c)
   * future session creation is blocked by UserDisabledError at the OAuth
   * callback and M5 gate. Order matters: disable in Postgres FIRST, so a
   * concurrent OAuth callback that reads the user row after this point sees
   * disabled_at set even if the session revoke below hasn't run yet.
   */
  async disable(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<AdminUserDetail> {
    const user = await this.users.disable(googleUserId, adminUsername);
    if (!user) throw new UserNotFoundError();

    const revokedCount = await this.sessions.revokeAllForUser(googleUserId, "user_revoked");
    this.audit.log({ event: "admin_user_disabled", googleUserId, adminUsername, revokedCount, ...fp });
    if (revokedCount > 0) {
      this.audit.log({
        event: "admin_user_sessions_revoked",
        googleUserId,
        adminUsername,
        reason: "user_revoked",
        revokedCount,
        ...fp,
      });
      this.metrics.inc("session_revoked", { reason: "user_revoked" });
    }
    this.metrics.inc("admin_user_disabled");
    return this.getDetail(googleUserId);
  }

  async restore(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<AdminUserDetail> {
    const user = await this.users.restore(googleUserId, adminUsername);
    if (!user) throw new UserNotFoundError();

    this.audit.log({ event: "admin_user_restored", googleUserId, adminUsername, ...fp });
    this.metrics.inc("admin_user_restored");
    return this.getDetail(googleUserId);
  }

  /** Force Logout without disabling — "view active session info" + kick. */
  async forceLogout(
    googleUserId: string,
    adminUsername: string,
    fp: RequestFingerprint
  ): Promise<{ revokedCount: number }> {
    const user = await this.users.findById(googleUserId);
    if (!user) throw new UserNotFoundError();

    const revokedCount = await this.sessions.revokeAllForUser(googleUserId, "user_revoked");
    this.audit.log({
      event: "admin_user_sessions_revoked",
      googleUserId,
      adminUsername,
      reason: "user_revoked",
      revokedCount,
      ...fp,
    });
    if (revokedCount > 0) this.metrics.inc("session_revoked", { reason: "user_revoked" });
    return { revokedCount };
  }

  async auditHistory(
    googleUserId: string,
    cursor: string | undefined,
    limit: number
  ): Promise<AuditQueryResult> {
    if (!this.audit.query) return { entries: [], nextCursor: null, total: 0 };
    return this.audit.query({ googleUserId, cursor, limit });
  }

  private async loadActiveSession(googleUserId: string): Promise<ActiveSessionInfo | null> {
    const activeSession = await this.sessions.findActiveForUser(googleUserId);
    return activeSession
      ? {
          device: activeSession.device,
          browser: activeSession.browser,
          ip: activeSession.ip,
          lastActivityAt: activeSession.lastActivityAt.toISOString(),
        }
      : null;
  }
}
