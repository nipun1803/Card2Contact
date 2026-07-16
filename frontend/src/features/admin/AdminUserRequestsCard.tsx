import { useState } from "react";
import { useUserUpgradeRequests, useRequestActions } from "@/features/admin/useAdminLicenses";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { Input } from "@/shared/components/ui/input";
import {
  describeRequestAsk,
  REQUEST_STATUS_BADGE_VARIANT,
  REQUEST_STATUS_LABEL,
} from "@/shared/lib/tierRequest";
import type { TierRequest, TierRequestStatus } from "@/shared/types/api";

/**
 * The inline Upgrade-Requests card on a user's License Detail page — the
 * per-user counterpart to the central Requests queue. An admin can approve or
 * reject a pending request right where they're already managing the user's
 * quota. Shares useRequestActions with the queue, so a decision here refreshes
 * both. See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

function statusBadge(status: TierRequestStatus) {
  return <Badge variant={REQUEST_STATUS_BADGE_VARIANT[status]}>{REQUEST_STATUS_LABEL[status]}</Badge>;
}

export function AdminUserRequestsCard({ googleUserId }: { googleUserId: string }) {
  const { data, isLoading } = useUserUpgradeRequests(googleUserId);
  const { approve, reject } = useRequestActions();
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const requests = data?.data.requests ?? [];

  async function doApprove(r: TierRequest) {
    try {
      await approve.mutateAsync({ id: r.id, override: {} });
    } catch {
      /* surfaced via approve.error below */
    }
  }
  async function doReject(id: number) {
    try {
      await reject.mutateAsync({ id, note: rejectNote.trim() || undefined });
      setRejectingId(null);
      setRejectNote("");
    } catch {
      /* surfaced via reject.error below */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upgrade Requests</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="text-muted-foreground">No upgrade requests from this user.</p>
        ) : (
          requests.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{describeRequestAsk(r)}</span>
                {statusBadge(r.status)}
              </div>
              {r.userNote && <p className="mt-1 text-muted-foreground">“{r.userNote}”</p>}
              {r.status === "pending" ? (
                rejectingId === r.id ? (
                  <div className="mt-3 space-y-2">
                    <Input
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                      placeholder="Reason (optional, shown to the user)"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        loading={reject.isPending}
                        onClick={() => void doReject(r.id)}
                      >
                        Confirm reject
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRejectingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={approve.isPending}
                      onClick={() => void doApprove(r)}
                    >
                      Approve as asked
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setRejectingId(r.id)}>
                      Reject
                    </Button>
                  </div>
                )
              ) : (
                r.decisionNote && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Decision: {r.decisionNote}
                    {r.decidedBy ? ` (${r.decidedBy})` : ""}
                  </p>
                )
              )}
            </div>
          ))
        )}
        {(approve.isError || reject.isError) && (
          <p role="alert" className="text-destructive">
            {(approve.error ?? reject.error) instanceof Error
              ? (approve.error ?? reject.error)!.message
              : "Something went wrong"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
