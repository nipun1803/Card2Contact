import { useState } from "react";
import { Ban, Gauge, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { useMyPlan } from "@/features/plan/useMyPlan";
import { UpgradeRequestDialog } from "@/features/plan/UpgradeRequestDialog";

/**
 * Shown when the backend refuses a scan at OCR (License Management):
 * - "quota" → 402 QUOTA_EXCEEDED: the user is out of scan allowance.
 * - "blocked" → 403 SCAN_BLOCKED: an admin blocked this user's scanning.
 *
 * The two are distinct backend codes and stay distinct here. For the quota case
 * the user CAN act — see their current plan, request an upgrade, or refresh in
 * case an admin just granted more. The blocked case is admin-only to resolve, so
 * it stays a plain explanation.
 */
export function ScanLimitPanel({ kind, onBack }: { kind: "quota" | "blocked"; onBack: () => void }) {
  const quota = kind === "quota";
  const Icon = quota ? Gauge : Ban;
  // Only the quota panel needs plan data; the hook is cheap and cached, and the
  // blocked panel simply ignores it.
  const { data, refetch, isFetching } = useMyPlan();
  const [dialogOpen, setDialogOpen] = useState(false);

  const plan = data?.data;
  const q = plan?.quota;
  const tierName = q ? (q.unlimited ? q.activeTier?.name ?? "Unlimited" : q.activeTier?.name ?? "Free") : null;

  return (
    <Card className="mx-auto max-w-md text-center">
      <CardContent className="flex flex-col items-center gap-5 p-8">
        <span className="flex size-14 items-center justify-center rounded-full bg-warning/15 text-warning-foreground">
          <Icon className="size-6" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold">
            {quota ? "You’re out of scans" : "Scanning is blocked"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {quota
              ? "You’ve used all your available scans. Request an upgrade or ask an administrator for more."
              : "An administrator has blocked scanning for your account. Contact them if you think this is a mistake."}
          </p>
        </div>

        {/* Quota panel: show the current plan + usage. */}
        {quota && q && (
          <div className="w-full rounded-md border border-border bg-secondary/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Current plan</span>
              <Badge variant={q.unlimited ? "success" : "primary"}>{tierName}</Badge>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-muted-foreground">Used / Remaining</span>
              <span className="font-medium">
                {q.freeUsed} / {q.unlimited ? "∞" : q.totalRemaining}
              </span>
            </div>
          </div>
        )}

        {quota ? (
          <div className="flex w-full flex-col gap-2">
            <Button variant="primary" onClick={() => setDialogOpen(true)} className="w-full">
              Request upgrade
            </Button>
            <Button
              variant="secondary"
              onClick={() => void refetch()}
              loading={isFetching}
              className="w-full"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
              Refresh status
            </Button>
            <Button variant="ghost" onClick={onBack} className="w-full">
              Back
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={onBack} className="w-full">
            Back
          </Button>
        )}
      </CardContent>

      {plan && (
        <UpgradeRequestDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          tiers={plan.availableTiers}
        />
      )}
    </Card>
  );
}
