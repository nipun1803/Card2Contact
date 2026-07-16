import { useState } from "react";
import { Gauge, Infinity as InfinityIcon, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { useMyPlan } from "@/features/plan/useMyPlan";
import { UpgradeRequestDialog } from "@/features/plan/UpgradeRequestDialog";
import type { MyQuota, TierRequest } from "@/shared/types/api";

/**
 * The user-facing "Your Plan" card (Profile page primary surface). Shows the
 * active tier, a usage bar, remaining scans (or Unlimited), the current
 * pending-request state, and recent decisions with the admin's reason. All data
 * comes from GET /api/me/plan — the single source of truth shared with the
 * admin's view. See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** The usage bar: used vs total, or a full "unlimited" bar. */
function UsageBar({ quota }: { quota: MyQuota }) {
  if (quota.unlimited) {
    return (
      <div className="h-2 w-full overflow-hidden rounded-full bg-success/20">
        <div className="h-full w-full bg-success" />
      </div>
    );
  }
  // Capacity this cycle = the free limit plus whatever paid is still drawable.
  const used = quota.freeUsed;
  const capacity = quota.freeLimit + quota.paidRemaining;
  const pct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 100;
  const low = quota.totalRemaining <= 3;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
      <div
        className={low ? "h-full bg-warning" : "h-full bg-primary"}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function pendingSummary(r: TierRequest): string {
  if (r.kind === "tier") return r.requestedTierName ?? "a plan upgrade";
  const parts: string[] = [];
  if (r.requestedAmount != null) parts.push(`${r.requestedAmount} scans`);
  if (r.requestedDays != null) parts.push(`${r.requestedDays} days`);
  return parts.length ? parts.join(", ") : "a custom allowance";
}

export function PlanCard() {
  const { data, isLoading, isError } = useMyPlan();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Plan</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Plan</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Could not load your plan right now.</p>
        </CardContent>
      </Card>
    );
  }

  const { quota, availableTiers, pendingRequest, recentRequests } = data.data;
  const tierName = quota.unlimited ? quota.activeTier?.name ?? "Unlimited" : quota.activeTier?.name ?? "Free";
  // Decisions the user hasn't necessarily seen — show the most recent decided one.
  const lastDecided = recentRequests.find((r) => r.status !== "pending");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Your Plan</CardTitle>
        <Badge variant={quota.unlimited ? "success" : "primary"}>{tierName}</Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Allowance */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {quota.unlimited ? (
                <InfinityIcon className="size-4" aria-hidden />
              ) : (
                <Gauge className="size-4" aria-hidden />
              )}
              Scans remaining
            </span>
            <span className="font-semibold">
              {quota.unlimited ? "Unlimited" : quota.totalRemaining}
            </span>
          </div>
          <UsageBar quota={quota} />
          {!quota.unlimited && (
            <p className="text-xs text-muted-foreground">
              {quota.freeUsed} used · {quota.freeRemaining} free + {quota.paidRemaining} paid
              remaining
            </p>
          )}
          {quota.activeTier?.expiresAt && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" aria-hidden />
              Renews / expires {formatDate(quota.activeTier.expiresAt)}
            </p>
          )}
          {quota.scanBlocked && (
            <p className="text-xs text-warning-foreground">
              Scanning is currently blocked on your account. Contact an administrator.
            </p>
          )}
        </div>

        {/* Pending request state, or the upgrade action. */}
        {pendingRequest ? (
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <Clock className="size-4 text-warning-foreground" aria-hidden />
              Request pending
            </p>
            <p className="mt-1 text-muted-foreground">
              You requested {pendingSummary(pendingRequest)}. An administrator will review it.
            </p>
          </div>
        ) : (
          <Button variant="primary" onClick={() => setDialogOpen(true)} disabled={quota.scanBlocked}>
            Request an upgrade
          </Button>
        )}

        {/* Most recent decision, with the admin's note. */}
        {lastDecided && (
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              {lastDecided.status === "approved" ? (
                <CheckCircle2 className="size-4 text-success" aria-hidden />
              ) : (
                <XCircle className="size-4 text-muted-foreground" aria-hidden />
              )}
              Last request {lastDecided.status}
            </p>
            {lastDecided.decisionNote && (
              <p className="mt-1 text-muted-foreground">“{lastDecided.decisionNote}”</p>
            )}
          </div>
        )}
      </CardContent>

      <UpgradeRequestDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        tiers={availableTiers}
      />
    </Card>
  );
}
