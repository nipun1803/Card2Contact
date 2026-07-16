import { Router, RequestHandler } from "express";
import { AdminUserService, AdminUserDetail } from "./admin-users.service";
import { fingerprint } from "../../shared/http/session";
import {
  UserRecord,
  UserStatusFilter,
  UserSortField,
  SortDirection,
} from "../../shared/store/user-store";

/**
 * Admin User Management router — mounted at /api/admin (see app.ts), so these
 * are /api/admin/users, /api/admin/users/:googleUserId, etc.
 *
 * Follows admin-auth.router.ts's contract: router.use(adminAuth) first, so
 * every route below structurally requires a live Admin Session.
 *
 * Every /api/admin/users* success response is wrapped in a {data, meta?}
 * envelope — a convention scoped to this surface only (see
 * docs/modules/admin/USER_MANAGEMENT.md's "Endpoints > Conventions" section
 * for why it isn't retrofitted onto the rest of the app). Errors are
 * unchanged: still {error, code?} via the existing error-handler.ts.
 *
 * See docs/modules/admin/USER_MANAGEMENT.md.
 */

export interface AdminUsersRouterDeps {
  service: AdminUserService;
  adminAuth: RequestHandler;
}

interface ListParams {
  limit: number;
  cursor?: string;
  search?: string;
  status: UserStatusFilter;
  sortField?: UserSortField;
  sortDirection?: SortDirection;
  registeredAfter?: string;
  registeredBefore?: string;
  lastLoginAfter?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseListParams(query: Record<string, unknown>): ListParams {
  return {
    limit: Math.min(100, Math.max(1, Number(query.limit) || 20)),
    cursor: str(query.cursor),
    search: str(query.search),
    status: (str(query.status) as UserStatusFilter | undefined) ?? "all",
    sortField: str(query.sortField) as UserSortField | undefined,
    sortDirection: str(query.sortDirection) as SortDirection | undefined,
    registeredAfter: str(query.registeredAfter),
    registeredBefore: str(query.registeredBefore),
    lastLoginAfter: str(query.lastLoginAfter),
  };
}

// Never leak accessToken/refreshToken to the admin client.
function toUserSummaryJson(u: UserRecord) {
  return {
    googleUserId: u.googleUserId,
    email: u.email,
    spreadsheetTitle: u.spreadsheetTitle,
    savedContactsCount: u.savedContactsCount,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    disabled: u.disabledAt !== null,
    disabledAt: u.disabledAt,
    disabledBy: u.disabledBy,
    restoredAt: u.restoredAt,
    restoredBy: u.restoredBy,
  };
}

function toUserDetailJson(u: AdminUserDetail) {
  return { ...toUserSummaryJson(u), activeSession: u.activeSession };
}

export function createAdminUsersRouter(deps: AdminUsersRouterDeps): Router {
  const { service, adminAuth } = deps;
  const router = Router();
  router.use(adminAuth); // FIRST — every route below requires an Admin Session

  // GET /api/admin/users?cursor=&limit=&search=&status=active|disabled|all
  //     &sortField=&sortDirection=&registeredAfter=&registeredBefore=&lastLoginAfter=
  router.get("/users", async (req, res, next) => {
    try {
      const params = parseListParams(req.query as Record<string, unknown>);
      const [{ users, nextCursor, total, totalPages }, stats] = await Promise.all([
        service.list(params),
        service.stats(),
      ]);
      res.json({
        data: { users: users.map(toUserSummaryJson), stats },
        meta: { page: { total, totalPages, nextCursor, limit: params.limit } },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/users/:googleUserId
  router.get("/users/:googleUserId", async (req, res, next) => {
    try {
      const detail = await service.getDetail(req.params.googleUserId);
      res.json({ data: toUserDetailJson(detail) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/users/:googleUserId/audit?cursor=&limit=
  router.get("/users/:googleUserId/audit", async (req, res, next) => {
    try {
      const { cursor, limit } = parseListParams(req.query as Record<string, unknown>);
      const result = await service.auditHistory(req.params.googleUserId, cursor, limit);
      res.json({
        data: { entries: result.entries },
        meta: {
          page: {
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
            nextCursor: result.nextCursor,
            limit,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/users/:googleUserId/disable — Revoke Access
  router.post("/users/:googleUserId/disable", async (req, res, next) => {
    try {
      const detail = await service.disable(req.params.googleUserId, req.adminAuth!.username, fingerprint(req));
      res.json({ data: toUserDetailJson(detail) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/users/:googleUserId/restore
  router.post("/users/:googleUserId/restore", async (req, res, next) => {
    try {
      const detail = await service.restore(req.params.googleUserId, req.adminAuth!.username, fingerprint(req));
      res.json({ data: toUserDetailJson(detail) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/users/:googleUserId/force-logout
  router.post("/users/:googleUserId/force-logout", async (req, res, next) => {
    try {
      const result = await service.forceLogout(req.params.googleUserId, req.adminAuth!.username, fingerprint(req));
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
