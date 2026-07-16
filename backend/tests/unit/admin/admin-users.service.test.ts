import { describe, expect, it, vi } from "vitest";
import { AdminUserService, UserNotFoundError } from "../../../src/modules/admin-users/admin-users.service";
import { MemoryAuditLogger } from "../../../src/shared/audit/audit-logger";
import { MemoryMetrics } from "../../../src/shared/observability/metrics";
import { makeSessionStore, makeUserStore } from "../../mocks/stores";
import { makeUser } from "../../fixtures/contacts";

const FP = { device: "macOS", browser: "Chrome", ip: "203.0.113.1" };
const ADMIN = "admin";

function ctx() {
  const users = makeUserStore({ findById: vi.fn(async () => makeUser()) });
  const sessions = makeSessionStore();
  const audit = new MemoryAuditLogger();
  const metrics = new MemoryMetrics();
  const service = new AdminUserService(users, sessions, audit, metrics);
  return { users, sessions, audit, metrics, service };
}

describe("AdminUserService.disable", () => {
  it("S1: calls users.disable then sessions.revokeAllForUser, in that order", async () => {
    const { users, sessions, service } = ctx();
    const calls: string[] = [];
    (users.disable as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push("users.disable");
      return makeUser({ disabledAt: new Date(), disabledBy: ADMIN });
    });
    (sessions.revokeAllForUser as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push("sessions.revokeAllForUser");
      return 1;
    });

    await service.disable("u1", ADMIN, FP);

    expect(calls).toEqual(["users.disable", "sessions.revokeAllForUser"]);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith("u1", "user_revoked");
  });

  it("S2: throws UserNotFoundError when the user doesn't exist", async () => {
    const { users, service } = ctx();
    (users.disable as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.disable("missing", ADMIN, FP)).rejects.toThrow(UserNotFoundError);
  });

  it("S3: logs admin_user_disabled with revokedCount", async () => {
    const { users, sessions, audit, service } = ctx();
    (users.disable as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeUser({ disabledAt: new Date(), disabledBy: ADMIN })
    );
    (sessions.revokeAllForUser as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    await service.disable("u1", ADMIN, FP);

    const entries = audit.ofType("admin_user_disabled");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ googleUserId: "u1", adminUsername: ADMIN, revokedCount: 2 });
  });

  it("S4: does NOT emit admin_user_sessions_revoked when there was no active session", async () => {
    const { users, sessions, audit, service } = ctx();
    (users.disable as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeUser({ disabledAt: new Date(), disabledBy: ADMIN })
    );
    (sessions.revokeAllForUser as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    await service.disable("u1", ADMIN, FP);

    expect(audit.ofType("admin_user_sessions_revoked")).toHaveLength(0);
  });

  it("emits admin_user_sessions_revoked when a session WAS revoked", async () => {
    const { users, sessions, audit, service } = ctx();
    (users.disable as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeUser({ disabledAt: new Date(), disabledBy: ADMIN })
    );
    (sessions.revokeAllForUser as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await service.disable("u1", ADMIN, FP);

    expect(audit.ofType("admin_user_sessions_revoked")).toHaveLength(1);
  });
});

describe("AdminUserService.restore", () => {
  it("S5: logs admin_user_restored", async () => {
    const { users, audit, service } = ctx();
    (users.restore as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeUser({ disabledAt: null, restoredAt: new Date(), restoredBy: ADMIN })
    );

    await service.restore("u1", ADMIN, FP);

    expect(audit.ofType("admin_user_restored")).toHaveLength(1);
  });

  it("throws UserNotFoundError when the user doesn't exist", async () => {
    const { users, service } = ctx();
    (users.restore as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.restore("missing", ADMIN, FP)).rejects.toThrow(UserNotFoundError);
  });
});

describe("AdminUserService.forceLogout", () => {
  it("S6: revokes sessions without touching disabled_at", async () => {
    const { users, sessions, service } = ctx();
    (sessions.revokeAllForUser as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const result = await service.forceLogout("u1", ADMIN, FP);

    expect(result).toEqual({ revokedCount: 1 });
    expect(users.disable).not.toHaveBeenCalled();
    expect(users.restore).not.toHaveBeenCalled();
  });

  it("throws UserNotFoundError when the user doesn't exist", async () => {
    const { users, service } = ctx();
    (users.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.forceLogout("missing", ADMIN, FP)).rejects.toThrow(UserNotFoundError);
  });
});

describe("AdminUserService.getDetail", () => {
  it("S7: includes activeSession: null when there is no active session", async () => {
    const { service } = ctx();

    const detail = await service.getDetail("u1");

    expect(detail.activeSession).toBeNull();
  });

  it("includes activeSession details when a session is active", async () => {
    const { sessions, service } = ctx();
    sessions._seed({ googleUserId: "u1", device: "iOS", browser: "Safari", ip: "203.0.113.9" });

    const detail = await service.getDetail("u1");

    expect(detail.activeSession).toMatchObject({ device: "iOS", browser: "Safari" });
  });

  it("throws UserNotFoundError when the user doesn't exist", async () => {
    const { users, service } = ctx();
    (users.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.getDetail("missing")).rejects.toThrow(UserNotFoundError);
  });
});

describe("AdminUserService.auditHistory", () => {
  it("returns an empty page when the audit sink doesn't support querying", async () => {
    const users = makeUserStore();
    const sessions = makeSessionStore();
    const metrics = new MemoryMetrics();
    const service = new AdminUserService(users, sessions, { log: () => {} }, metrics);

    const result = await service.auditHistory("u1", undefined, 20);

    expect(result).toEqual({ entries: [], nextCursor: null, total: 0 });
  });

  it("delegates to the audit sink's query() when available", async () => {
    const { audit, service } = ctx();
    audit.log({ event: "login", googleUserId: "u1" });

    const result = await service.auditHistory("u1", undefined, 20);

    expect(result.total).toBe(1);
    expect(result.entries[0]).toMatchObject({ event: "login", googleUserId: "u1" });
  });
});
