import { Router, RequestHandler } from "express";
import { AdminLicenseService } from "./admin-licenses.service";
import { fingerprint } from "../../shared/http/session";
import {
  EffectiveQuota,
  ListQuotasParams,
  QuotaStatusFilter,
  QuotaSortField,
  SortDirection,
  TierAssignmentEntry,
} from "../../shared/store/quota-store";
import { LicenseSettings } from "../../shared/store/license-settings-store";
import { Tier, TierWithCount } from "../../shared/store/tier-store";
import { TierRequest } from "../../shared/store/tier-request-store";

/**
 * License Management router — mounted at /api/admin (see app.ts), so these are
 * /api/admin/licenses/settings, /api/admin/licenses/quotas, etc.
 *
 * Same contract as admin-users.router.ts: router.use(adminAuth) FIRST, so every
 * route structurally requires a live Admin Session; every success response is a
 * {data, meta?} envelope (a convention scoped to the /api/admin surface); errors
 * stay {error, code?} via error-handler.ts.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

export interface AdminLicensesRouterDeps {
  service: AdminLicenseService;
  adminAuth: RequestHandler;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseListParams(query: Record<string, unknown>): ListQuotasParams {
  return {
    limit: Math.min(100, Math.max(1, Number(query.limit) || 20)),
    cursor: str(query.cursor),
    search: str(query.search),
    status: (str(query.status) as QuotaStatusFilter | undefined) ?? "all",
    sortField: str(query.sortField) as QuotaSortField | undefined,
    sortDirection: str(query.sortDirection) as SortDirection | undefined,
  };
}

/** Serialize the effective quota for the admin client. */
function toQuotaJson(q: EffectiveQuota) {
  return {
    googleUserId: q.googleUserId,
    email: q.email ?? null,
    freeLimit: q.freeLimit,
    freeUsed: q.freeUsed,
    freeRemaining: q.freeRemaining,
    hasFreeOverride: q.hasFreeOverride,
    paidRemaining: q.paidRemaining,
    totalRemaining: q.totalRemaining,
    scanBlocked: q.scanBlock.blocked,
    scanBlockedAt: q.scanBlock.blockedAt,
    scanBlockedBy: q.scanBlock.blockedBy,
    unlimited: q.unlimited,
    activeTier: q.activeTier
      ? {
          tierId: q.activeTier.tierId,
          name: q.activeTier.name,
          unlimited: q.activeTier.unlimited,
          unlimitedUntil: q.activeTier.unlimitedUntil,
          expiresAt: q.activeTier.expiresAt,
        }
      : null,
    paidGrants: q.paidGrants.map((g) => ({
      id: g.id,
      amount: g.amount,
      used: g.used,
      remaining: g.amount - g.used,
      expiresAt: g.expiresAt,
      grantedAt: g.grantedAt,
      grantedBy: g.grantedBy,
      status: g.status,
      reason: g.reason,
    })),
  };
}

function toTierJson(t: Tier | TierWithCount) {
  return {
    id: t.id,
    name: t.name,
    isUnlimited: t.isUnlimited,
    scanLimit: t.scanLimit,
    validityDays: t.validityDays,
    isDefault: t.isDefault,
    sortOrder: t.sortOrder,
    archivedAt: t.archivedAt,
    updatedAt: t.updatedAt,
    updatedBy: t.updatedBy,
    ...("assignedCount" in t ? { assignedCount: t.assignedCount } : {}),
  };
}

function toTierAssignmentJson(a: TierAssignmentEntry) {
  return {
    id: a.id,
    tierId: a.tierId,
    tierName: a.tierName,
    isUnlimited: a.isUnlimited,
    scanLimit: a.scanLimit,
    validityDays: a.validityDays,
    expiresAt: a.expiresAt,
    previousTierId: a.previousTierId,
    previousTierName: a.previousTierName,
    action: a.action,
    assignedBy: a.assignedBy,
    assignedAt: a.assignedAt,
  };
}

/** Full request serialization for the admin queue — includes user note + decision. */
function toRequestJson(r: TierRequest) {
  return {
    id: r.id,
    googleUserId: r.googleUserId,
    email: r.email ?? null,
    kind: r.kind,
    requestedTierId: r.requestedTierId,
    requestedTierName: r.requestedTierName,
    requestedAmount: r.requestedAmount,
    requestedDays: r.requestedDays,
    userNote: r.userNote,
    currentTierName: r.currentTierName,
    status: r.status,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    grantedTierId: r.grantedTierId,
    grantedAmount: r.grantedAmount,
    grantedDays: r.grantedDays,
    createdAt: r.createdAt,
  };
}

function toSettingsJson(s: LicenseSettings) {
  return {
    defaultFreeLimit: s.defaultFreeLimit,
    defaultPaidLimit: s.defaultPaidLimit,
    freeEnabled: s.freeEnabled,
    paidEnabled: s.paidEnabled,
    enforcementEnabled: s.enforcementEnabled,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  };
}

export function createAdminLicensesRouter(deps: AdminLicensesRouterDeps): Router {
  const { service, adminAuth } = deps;
  const router = Router();
  router.use(adminAuth); // FIRST — every route below requires an Admin Session

  const admin = (req: Parameters<RequestHandler>[0]) => req.adminAuth!.username;

  // GET /api/admin/licenses/settings
  router.get("/licenses/settings", async (_req, res, next) => {
    try {
      res.json({ data: toSettingsJson(await service.getSettings()) });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/admin/licenses/settings
  router.patch("/licenses/settings", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch = {
        defaultFreeLimit: numOrUndefined(body.defaultFreeLimit),
        defaultPaidLimit: numOrUndefined(body.defaultPaidLimit),
        freeEnabled: boolOrUndefined(body.freeEnabled),
        paidEnabled: boolOrUndefined(body.paidEnabled),
        enforcementEnabled: boolOrUndefined(body.enforcementEnabled),
      };
      const next_ = await service.updateSettings(patch, admin(req), fingerprint(req));
      res.json({ data: toSettingsJson(next_) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/licenses/quotas?cursor=&limit=&search=&status=&sort=
  router.get("/licenses/quotas", async (req, res, next) => {
    try {
      const params = parseListParams(req.query as Record<string, unknown>);
      const [{ quotas, nextCursor, total, totalPages }, stats] = await Promise.all([
        service.list(params),
        service.stats(),
      ]);
      res.json({
        data: { quotas: quotas.map(toQuotaJson), stats },
        meta: { page: { total, totalPages, nextCursor, limit: params.limit } },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/licenses/quotas/:googleUserId
  router.get("/licenses/quotas/:googleUserId", async (req, res, next) => {
    try {
      res.json({ data: toQuotaJson(await service.getQuota(req.params.googleUserId)) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/licenses/quotas/:googleUserId/history?cursor=&limit=
  router.get("/licenses/quotas/:googleUserId/history", async (req, res, next) => {
    try {
      const { cursor, limit } = parseListParams(req.query as Record<string, unknown>);
      const result = await service.history(req.params.googleUserId, cursor, limit);
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

  // PUT /api/admin/licenses/quotas/:googleUserId/free  { limit }
  router.put("/licenses/quotas/:googleUserId/free", async (req, res, next) => {
    try {
      const limit = Number((req.body ?? {}).limit);
      const quota = await service.setFreeLimit(
        req.params.googleUserId,
        limit,
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/licenses/quotas/:googleUserId/free  — reset to default
  router.delete("/licenses/quotas/:googleUserId/free", async (req, res, next) => {
    try {
      const quota = await service.removeFreeOverride(
        req.params.googleUserId,
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/quotas/:googleUserId/paid/grants  { amount, expiresAt?, reason? }
  router.post("/licenses/quotas/:googleUserId/paid/grants", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const quota = await service.grantPaid(
        req.params.googleUserId,
        {
          amount: Number(body.amount),
          expiresAt: str(body.expiresAt) ?? null,
          reason: str(body.reason),
        },
        admin(req),
        fingerprint(req)
      );
      res.status(201).json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/licenses/quotas/:googleUserId/paid/grants/:grantId
  router.delete("/licenses/quotas/:googleUserId/paid/grants/:grantId", async (req, res, next) => {
    try {
      const quota = await service.revokeGrant(
        req.params.googleUserId,
        Number(req.params.grantId),
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/quotas/:googleUserId/paid/reset  — revoke all grants
  router.post("/licenses/quotas/:googleUserId/paid/reset", async (req, res, next) => {
    try {
      const quota = await service.resetPaid(req.params.googleUserId, admin(req), fingerprint(req));
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/quotas/:googleUserId/reset  { pool: free|paid|both }
  router.post("/licenses/quotas/:googleUserId/reset", async (req, res, next) => {
    try {
      const pool = (str((req.body ?? {}).pool) as "free" | "paid" | "both" | undefined) ?? "both";
      const quota = await service.resetUsed(req.params.googleUserId, pool, admin(req), fingerprint(req));
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/quotas/:googleUserId/recalculate
  router.post("/licenses/quotas/:googleUserId/recalculate", async (req, res, next) => {
    try {
      const quota = await service.recalculate(req.params.googleUserId, admin(req), fingerprint(req));
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/quotas/:googleUserId/scan-block
  router.post("/licenses/quotas/:googleUserId/scan-block", async (req, res, next) => {
    try {
      const quota = await service.setScanBlocked(
        req.params.googleUserId,
        true,
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/quotas/:googleUserId/scan-unblock
  router.post("/licenses/quotas/:googleUserId/scan-unblock", async (req, res, next) => {
    try {
      const quota = await service.setScanBlocked(
        req.params.googleUserId,
        false,
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // ── Tier catalog ───────────────────────────────────────────────────────────

  // GET /api/admin/licenses/tiers?search=
  router.get("/licenses/tiers", async (req, res, next) => {
    try {
      const tiers = await service.listTiers(str((req.query as Record<string, unknown>).search));
      res.json({ data: { tiers: tiers.map(toTierJson) } });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/tiers  { name, isUnlimited, scanLimit?, validityDays?, sortOrder? }
  router.post("/licenses/tiers", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tier = await service.createTier(
        {
          name: String(body.name ?? ""),
          isUnlimited: body.isUnlimited === true,
          scanLimit: numOrNull(body.scanLimit),
          validityDays: numOrNull(body.validityDays),
          sortOrder: numOrUndefined(body.sortOrder),
        },
        admin(req),
        fingerprint(req)
      );
      res.status(201).json({ data: toTierJson(tier) });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/admin/licenses/tiers/:id
  router.patch("/licenses/tiers/:id", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tier = await service.updateTier(
        Number(req.params.id),
        {
          name: str(body.name),
          isUnlimited: boolOrUndefined(body.isUnlimited),
          scanLimit: "scanLimit" in body ? numOrNull(body.scanLimit) : undefined,
          validityDays: "validityDays" in body ? numOrNull(body.validityDays) : undefined,
          sortOrder: numOrUndefined(body.sortOrder),
        },
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toTierJson(tier) });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/licenses/tiers/:id  (archive)
  router.delete("/licenses/tiers/:id", async (req, res, next) => {
    try {
      await service.archiveTier(Number(req.params.id), admin(req), fingerprint(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/tiers/:id/clone  { name }
  router.post("/licenses/tiers/:id/clone", async (req, res, next) => {
    try {
      const name = String((req.body ?? {}).name ?? "");
      const tier = await service.cloneTier(Number(req.params.id), name, admin(req), fingerprint(req));
      res.status(201).json({ data: toTierJson(tier) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/tiers/:id/bulk-assign  { googleUserIds: [...] }
  router.post("/licenses/tiers/:id/bulk-assign", async (req, res, next) => {
    try {
      const ids = (req.body ?? {}).googleUserIds;
      const googleUserIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
      const result = await service.bulkAssignTier(
        googleUserIds,
        Number(req.params.id),
        admin(req),
        fingerprint(req)
      );
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // ── Per-user tier assignment ─────────────────────────────────────────────

  // POST /api/admin/licenses/quotas/:googleUserId/tier  { tierId }
  router.post("/licenses/quotas/:googleUserId/tier", async (req, res, next) => {
    try {
      const tierId = Number((req.body ?? {}).tierId);
      const quota = await service.assignTier(
        req.params.googleUserId,
        tierId,
        admin(req),
        fingerprint(req)
      );
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/licenses/quotas/:googleUserId/tier  (fall back to default)
  router.delete("/licenses/quotas/:googleUserId/tier", async (req, res, next) => {
    try {
      const quota = await service.removeTier(req.params.googleUserId, admin(req), fingerprint(req));
      res.json({ data: toQuotaJson(quota) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/licenses/quotas/:googleUserId/tier-history?cursor=&limit=
  router.get("/licenses/quotas/:googleUserId/tier-history", async (req, res, next) => {
    try {
      const { cursor, limit } = parseListParams(req.query as Record<string, unknown>);
      const result = await service.tierHistory(req.params.googleUserId, cursor, limit);
      res.json({
        data: { entries: result.entries.map(toTierAssignmentJson) },
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

  // ── Tier Upgrade Requests (admin queue) ──────────────────────────────────────

  // GET /api/admin/licenses/requests?status=&cursor=&limit=
  router.get("/licenses/requests", async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>;
      const status = str(q.status) as "pending" | "approved" | "rejected" | undefined;
      const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
      const page = await service.listRequests({ status, cursor: str(q.cursor), limit });
      res.json({
        data: { requests: page.requests.map(toRequestJson), pendingCount: page.pendingCount },
        meta: {
          page: {
            total: page.total,
            nextCursor: page.nextCursor,
            limit,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/licenses/requests/count — the nav badge (pending only).
  router.get("/licenses/requests/count", async (_req, res, next) => {
    try {
      res.json({ data: { pendingCount: await service.pendingRequestCount() } });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/licenses/quotas/:googleUserId/requests — a user's requests (inline on detail).
  router.get("/licenses/quotas/:googleUserId/requests", async (req, res, next) => {
    try {
      const requests = await service.requestsForUser(req.params.googleUserId);
      res.json({ data: { requests: requests.map(toRequestJson) } });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/requests/:id/approve
  //   { tierId?, amount?, days?, note? } — omit all to approve as requested.
  router.post("/licenses/requests/:id/approve", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await service.approveRequest(
        Number(req.params.id),
        {
          tierId: numOrNull(body.tierId),
          amount: numOrNull(body.amount),
          days: numOrNull(body.days),
          note: str(body.note) ?? null,
        },
        admin(req),
        fingerprint(req)
      );
      res.json({
        data: { request: toRequestJson(result.request), quota: toQuotaJson(result.quota) },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/licenses/requests/:id/reject  { note? }
  router.post("/licenses/requests/:id/reject", async (req, res, next) => {
    try {
      const note = str((req.body ?? {}).note) ?? null;
      const request = await service.rejectRequest(Number(req.params.id), note, admin(req), fingerprint(req));
      res.json({ data: toRequestJson(request) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function boolOrUndefined(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
