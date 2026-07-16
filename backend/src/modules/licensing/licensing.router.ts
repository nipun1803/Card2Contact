import { Router, RequestHandler } from "express";
import { LicensingService } from "./licensing.service";
import { EffectiveQuota } from "../../shared/store/quota-store";
import { TierRequest } from "../../shared/store/tier-request-store";
import { PublicTier } from "./licensing.service";

/**
 * User-facing License Management router — mounted at /api/me (see app.ts), behind
 * requireAuth (a Google Active Session). A user reads THEIR OWN plan and files an
 * upgrade request; there is no path here to change an allowance. All admin
 * actions live in admin-licenses.router (behind adminAuth) — the two never share
 * a route or an auth path.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

export interface LicensingRouterDeps {
  service: LicensingService;
  requireAuth: RequestHandler;
}

function toPublicTierJson(t: PublicTier) {
  return {
    id: t.id,
    name: t.name,
    isUnlimited: t.isUnlimited,
    scanLimit: t.scanLimit,
    validityDays: t.validityDays,
    isDefault: t.isDefault,
  };
}

/** The user's own quota — same numbers the admin sees, no internal fields. */
function toMyQuotaJson(q: EffectiveQuota) {
  return {
    freeLimit: q.freeLimit,
    freeUsed: q.freeUsed,
    freeRemaining: q.freeRemaining,
    paidRemaining: q.paidRemaining,
    totalRemaining: q.totalRemaining,
    unlimited: q.unlimited,
    scanBlocked: q.scanBlock.blocked,
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
      status: g.status,
    })),
  };
}

function toRequestJson(r: TierRequest) {
  return {
    id: r.id,
    kind: r.kind,
    requestedTierId: r.requestedTierId,
    requestedTierName: r.requestedTierName,
    requestedAmount: r.requestedAmount,
    requestedDays: r.requestedDays,
    userNote: r.userNote,
    currentTierName: r.currentTierName,
    status: r.status,
    decisionNote: r.decisionNote,
    grantedTierId: r.grantedTierId,
    grantedAmount: r.grantedAmount,
    grantedDays: r.grantedDays,
    decidedAt: r.decidedAt,
    createdAt: r.createdAt,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function createLicensingRouter(deps: LicensingRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = Router();
  router.use(requireAuth); // every route below requires a Google Active Session

  const userId = (req: Parameters<RequestHandler>[0]) => req.auth!.googleUserId;

  // GET /api/me/plan — quota + tier catalog + pending request + history.
  router.get("/me/plan", async (req, res, next) => {
    try {
      const plan = await service.myPlan(userId(req));
      res.json({
        data: {
          quota: toMyQuotaJson(plan.quota),
          availableTiers: plan.availableTiers.map(toPublicTierJson),
          pendingRequest: plan.pendingRequest ? toRequestJson(plan.pendingRequest) : null,
          recentRequests: plan.recentRequests.map(toRequestJson),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/me/requests — the user's own request history.
  router.get("/me/requests", async (req, res, next) => {
    try {
      const requests = await service.myRequests(userId(req));
      res.json({ data: { requests: requests.map(toRequestJson) } });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/me/requests — file an upgrade request.
  //   { kind: 'tier', tierId, note? } | { kind: 'custom', amount?, days?, note }
  router.post("/me/requests", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = str(body.kind) === "custom" ? "custom" : "tier";
      const request = await service.createRequest(userId(req), {
        kind,
        tierId: numOrNull(body.tierId),
        amount: numOrNull(body.amount),
        days: numOrNull(body.days),
        note: str(body.note) ?? null,
      });
      res.status(201).json({ data: toRequestJson(request) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
