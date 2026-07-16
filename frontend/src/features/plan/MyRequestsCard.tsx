import { useMyRequests } from "@/features/plan/useMyPlan";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Badge } from "@/shared/components/ui/badge";
import { EmptyState } from "@/shared/components/common/EmptyState";
import {
  describeRequestAsk,
  REQUEST_STATUS_BADGE_VARIANT,
  REQUEST_STATUS_LABEL,
} from "@/shared/lib/tierRequest";

/**
 * Read-only history of the user's own upgrade requests (GET /api/me/requests) —
 * PlanCard only surfaces the single latest decided one, this shows the full
 * list. See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */
export function MyRequestsCard() {
  const { data, isLoading } = useMyRequests();
  const requests = data?.data.requests ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My Requests</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : requests.length === 0 ? (
          <EmptyState
            title="No requests yet"
            description="Upgrade requests you file will show up here."
          />
        ) : (
          requests.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{describeRequestAsk(r)}</span>
                <Badge variant={REQUEST_STATUS_BADGE_VARIANT[r.status]}>
                  {REQUEST_STATUS_LABEL[r.status]}
                </Badge>
              </div>
              {r.userNote && <p className="mt-1 text-muted-foreground">“{r.userNote}”</p>}
              {r.status !== "pending" && r.decisionNote && (
                <p className="mt-1 text-xs text-muted-foreground">Decision: {r.decisionNote}</p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
