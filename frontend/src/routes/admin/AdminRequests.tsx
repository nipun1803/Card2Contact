import { useState } from "react";
import { Link } from "react-router-dom";
import { Inbox, CheckCircle2, XCircle } from "lucide-react";
import { useUpgradeRequests, useRequestActions } from "@/features/admin/useAdminLicenses";
import { DataTable, type DataTableColumn } from "@/shared/components/common/DataTable";
import { EmptyState } from "@/shared/components/common/EmptyState";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Select } from "@/shared/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { adminLicenseDetailPath } from "@/shared/lib/constants";
import {
  describeRequestAsk,
  REQUEST_STATUS_BADGE_VARIANT,
  REQUEST_STATUS_LABEL,
} from "@/shared/lib/tierRequest";
import type { TierRequest, TierRequestStatus } from "@/shared/types/api";

/**
 * Admin queue for Tier Upgrade Requests. Pending-first inbox; each row can be
 * approved (as-asked or with an override) or rejected with a reason. Approval
 * flows through the existing assignTier / grantPaid seam server-side — this UI
 * only expresses the decision. See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

function statusBadge(status: TierRequestStatus) {
  return <Badge variant={REQUEST_STATUS_BADGE_VARIANT[status]}>{REQUEST_STATUS_LABEL[status]}</Badge>;
}

export default function AdminRequests() {
  const [status, setStatus] = useState<TierRequestStatus | undefined>("pending");
  const { data, isLoading, isError, error, refetch } = useUpgradeRequests(status);
  const { approve, reject } = useRequestActions();

  // Decision dialogs. `approving`/`rejecting` hold the target request.
  const [approving, setApproving] = useState<TierRequest | null>(null);
  const [rejecting, setRejecting] = useState<TierRequest | null>(null);
  // Approve override fields (blank = approve exactly as asked).
  const [overrideNote, setOverrideNote] = useState("");
  const [rejectNote, setRejectNote] = useState("");

  function openApprove(r: TierRequest) {
    setOverrideNote("");
    setApproving(r);
  }
  function openReject(r: TierRequest) {
    setRejectNote("");
    setRejecting(r);
  }

  async function confirmApprove() {
    if (!approving) return;
    try {
      // Approve as-asked: no override fields. The server resolves the granted
      // tier/amount from the request itself.
      await approve.mutateAsync({
        id: approving.id,
        override: overrideNote.trim() ? { note: overrideNote.trim() } : {},
      });
      setApproving(null);
    } catch {
      // Surfaced via the dialog's error line below.
    }
  }

  async function confirmReject() {
    if (!rejecting) return;
    try {
      await reject.mutateAsync({ id: rejecting.id, note: rejectNote.trim() || undefined });
      setRejecting(null);
    } catch {
      // Surfaced via the dialog's error line below.
    }
  }

  const COLUMNS: DataTableColumn<TierRequest>[] = [
    {
      key: "user",
      header: "User",
      render: (r) =>
        r.googleUserId ? (
          <Link
            to={adminLicenseDetailPath(r.googleUserId)}
            className="font-medium text-primary hover:underline"
          >
            {r.email || r.googleUserId}
          </Link>
        ) : (
          "—"
        ),
    },
    { key: "kind", header: "Type", render: (r) => (r.kind === "tier" ? "Tier" : "Custom") },
    { key: "ask", header: "Requested", render: describeRequestAsk },
    { key: "current", header: "Current tier", render: (r) => r.currentTierName ?? "Free" },
    {
      key: "note",
      header: "Reason",
      render: (r) => (
        <span className="text-sm text-muted-foreground">{r.userNote || "—"}</span>
      ),
    },
    { key: "status", header: "Status", render: (r) => statusBadge(r.status) },
    {
      key: "actions",
      header: "",
      render: (r) =>
        r.status === "pending" ? (
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => openApprove(r)}>
              Approve
            </Button>
            <Button variant="secondary" size="sm" onClick={() => openReject(r)}>
              Reject
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {r.decidedBy ? `by ${r.decidedBy}` : ""}
          </span>
        ),
    },
  ];

  const requests = data?.data.requests ?? [];

  return (
    <PageContainer width="wide">
      <div className="space-y-6">
        <PageHeader
          title="Upgrade Requests"
          description="Review tier and custom scan requests. Approving grants through the same tiers and paid grants you manage elsewhere."
        />

        {isError ? (
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <div className="flex items-end gap-3">
              <Select
                label="Status"
                hideLabel
                value={status ?? "all"}
                onChange={(e) =>
                  setStatus(
                    e.target.value === "all" ? undefined : (e.target.value as TierRequestStatus),
                  )
                }
                className="w-44"
              >
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="all">All</option>
              </Select>
              {data?.data.pendingCount != null && (
                <span className="pb-2.5 text-sm text-muted-foreground">
                  {data.data.pendingCount} pending
                </span>
              )}
            </div>

            {requests.length === 0 && !isLoading ? (
              <EmptyState
                icon={Inbox}
                title="No requests"
                description="When users request an upgrade, they show up here."
              />
            ) : (
              <DataTable columns={COLUMNS} rows={requests} rowKey={(r) => String(r.id)} loading={isLoading} />
            )}
          </>
        )}
      </div>

      {/* Approve dialog — approve as asked, with an optional note. */}
      <Dialog open={approving !== null} onOpenChange={(open) => !open && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve request</DialogTitle>
            <DialogDescription>
              {approving
                ? `Grant ${describeRequestAsk(approving)} to ${approving.email || approving.googleUserId}. This applies immediately through the standard grant path.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="approve-note" className="text-sm font-medium">
              Note (optional)
            </label>
            <Input
              id="approve-note"
              value={overrideNote}
              onChange={(e) => setOverrideNote(e.target.value)}
              placeholder="Visible to the user"
            />
          </div>
          {approve.isError && (
            <p role="alert" className="text-sm text-destructive">
              {approve.error instanceof Error ? approve.error.message : "Something went wrong"}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproving(null)} disabled={approve.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={approve.isPending}
              onClick={() => void confirmApprove()}
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog — record an optional reason the user will see. */}
      <Dialog open={rejecting !== null} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject request</DialogTitle>
            <DialogDescription>
              {rejecting ? `Decline ${describeRequestAsk(rejecting)} for ${rejecting.email || rejecting.googleUserId}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="reject-note" className="text-sm font-medium">
              Reason (optional, shown to the user)
            </label>
            <Input
              id="reject-note"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="e.g. Please contact sales for Enterprise"
            />
          </div>
          {reject.isError && (
            <p role="alert" className="text-sm text-destructive">
              {reject.error instanceof Error ? reject.error.message : "Something went wrong"}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(null)} disabled={reject.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" loading={reject.isPending} onClick={() => void confirmReject()}>
              <XCircle className="mr-1.5 h-4 w-4" />
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
