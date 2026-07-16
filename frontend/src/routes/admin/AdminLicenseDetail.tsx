import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  useLicenseActions,
  useLicenseDetail,
  useLicenseHistory,
  useTierHistory,
  useTiers,
} from "@/features/admin/useAdminLicenses";
import { ConfirmDialog } from "@/shared/components/common/ConfirmDialog";
import { HistoryList } from "@/shared/components/common/HistoryList";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { Row } from "@/shared/components/common/Row";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Select } from "@/shared/components/ui/select";
import { Badge } from "@/shared/components/ui/badge";
import { AdminUserRequestsCard } from "@/features/admin/AdminUserRequestsCard";
import { ROUTES } from "@/shared/lib/constants";
import type { PaidGrant } from "@/shared/types/api";

type DialogKind =
  | { kind: "assignTier"; tierId: number }
  | { kind: "removeTier" }
  | { kind: "revokeGrant"; grantId: number }
  | { kind: "scanBlock" }
  | { kind: "scanUnblock" }
  | null;

function grantStatusVariant(status: PaidGrant["status"]) {
  if (status === "active") return "success" as const;
  if (status === "revoked") return "warning" as const;
  return "default" as const;
}

/** Scan License detail — one user's effective quota, tier, grants, and history. */
export default function AdminLicenseDetail() {
  const { googleUserId = "" } = useParams<{ googleUserId: string }>();
  const [dialog, setDialog] = useState<DialogKind>(null);

  // Local form state for the inline (non-confirmed) actions.
  const [tierSelect, setTierSelect] = useState<string>("");
  const [freeLimitInput, setFreeLimitInput] = useState<string>("");
  const [grantAmount, setGrantAmount] = useState<string>("");
  const [grantExpiry, setGrantExpiry] = useState<string>("");

  // Independent cursor stacks for the two history lists.
  const [historyStack, setHistoryStack] = useState<(string | undefined)[]>([undefined]);
  const historyCursor = historyStack[historyStack.length - 1];
  const [tierStack, setTierStack] = useState<(string | undefined)[]>([undefined]);
  const tierCursor = tierStack[tierStack.length - 1];

  const { data, isLoading, isError, error, refetch } = useLicenseDetail(googleUserId);
  const actions = useLicenseActions(googleUserId);
  const history = useLicenseHistory(googleUserId, historyCursor);
  const tierHistory = useTierHistory(googleUserId, tierCursor);
  const tiers = useTiers(undefined);

  if (isLoading) return <AppSplash message="Loading license…" />;

  if (isError || !data) {
    return (
      <PageContainer width="default">
        <ErrorState
          title="Couldn't load this license"
          message={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    );
  }

  const quota = data.data;

  async function handleConfirm() {
    try {
      if (dialog?.kind === "assignTier") await actions.assignTier.mutateAsync(dialog.tierId);
      if (dialog?.kind === "removeTier") await actions.removeTier.mutateAsync();
      if (dialog?.kind === "revokeGrant") await actions.revokeGrant.mutateAsync(dialog.grantId);
      if (dialog?.kind === "scanBlock") await actions.scanBlock.mutateAsync();
      if (dialog?.kind === "scanUnblock") await actions.scanUnblock.mutateAsync();
      setDialog(null);
    } catch {
      // Surfaced via dialogError below; keep the dialog open so the admin sees it.
    }
  }

  const pending =
    actions.assignTier.isPending ||
    actions.removeTier.isPending ||
    actions.revokeGrant.isPending ||
    actions.scanBlock.isPending ||
    actions.scanUnblock.isPending;

  const dialogError =
    (dialog?.kind === "assignTier" && actions.assignTier.error) ||
    (dialog?.kind === "removeTier" && actions.removeTier.error) ||
    (dialog?.kind === "revokeGrant" && actions.revokeGrant.error) ||
    (dialog?.kind === "scanBlock" && actions.scanBlock.error) ||
    (dialog?.kind === "scanUnblock" && actions.scanUnblock.error) ||
    null;

  const tierList = tiers.data?.data.tiers ?? [];

  async function handleSetFreeLimit() {
    const limit = Number(freeLimitInput);
    if (!Number.isFinite(limit)) return;
    try {
      await actions.setFreeLimit.mutateAsync(limit);
      setFreeLimitInput("");
    } catch {
      // Error surfaced via the mutation's error state below.
    }
  }

  async function handleGrantPaid() {
    const amount = Number(grantAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
      await actions.grantPaid.mutateAsync({
        amount,
        expiresAt: grantExpiry ? new Date(grantExpiry).toISOString() : null,
      });
      setGrantAmount("");
      setGrantExpiry("");
    } catch {
      // Error surfaced via the mutation's error state below.
    }
  }

  return (
    <PageContainer width="default">
      <div className="space-y-6">
        <Link
          to={ROUTES.adminLicenses}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to Scan Licenses
        </Link>

        <PageHeader
          title={quota.email || quota.googleUserId}
          description={`Scan License${quota.email ? ` · ${quota.googleUserId}` : ""}`}
          actions={
            quota.scanBlocked ? (
              <Badge variant="warning">Scan-blocked</Badge>
            ) : quota.unlimited ? (
              <Badge variant="success">Unlimited</Badge>
            ) : (
              <Badge variant="success">Active</Badge>
            )
          }
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Current Allowance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {quota.unlimited ? (
                <>
                  <Row label="Allowance" value="Unlimited" />
                  <Row label="Tier" value={quota.activeTier?.name ?? "—"} />
                  <Row
                    label="Unlimited until"
                    value={
                      quota.activeTier?.unlimitedUntil
                        ? new Date(quota.activeTier.unlimitedUntil).toLocaleString()
                        : "No expiry"
                    }
                  />
                </>
              ) : (
                <>
                  <Row label="Free" value={`${quota.freeUsed}/${quota.freeLimit}`} />
                  <Row label="Free remaining" value={String(quota.freeRemaining)} />
                  <Row label="Paid remaining" value={String(quota.paidRemaining)} />
                  <Row label="Total remaining" value={String(quota.totalRemaining)} />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tier</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Active tier" value={quota.activeTier?.name ?? "Free (default)"} />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Select
                  label="Assign a tier"
                  hideLabel
                  value={tierSelect}
                  onChange={(e) => setTierSelect(e.target.value)}
                  className="flex-1"
                >
                  <option value="">Select a tier…</option>
                  {tierList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="primary"
                  disabled={pending || tierSelect === ""}
                  onClick={() => setDialog({ kind: "assignTier", tierId: Number(tierSelect) })}
                >
                  Assign Tier
                </Button>
              </div>
              <Button
                variant="secondary"
                disabled={pending || quota.activeTier === null}
                onClick={() => setDialog({ kind: "removeTier" })}
              >
                Remove Tier
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Free Override</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Has override" value={quota.hasFreeOverride ? "Yes" : "No"} />
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  type="number"
                  min={0}
                  placeholder="Free limit"
                  value={freeLimitInput}
                  onChange={(e) => setFreeLimitInput(e.target.value)}
                  className="flex-1"
                />
                <Button
                  variant="primary"
                  loading={actions.setFreeLimit.isPending}
                  disabled={freeLimitInput === ""}
                  onClick={() => void handleSetFreeLimit()}
                >
                  Set limit
                </Button>
              </div>
              <Button
                variant="secondary"
                loading={actions.removeFreeOverride.isPending}
                disabled={!quota.hasFreeOverride}
                onClick={() => void actions.removeFreeOverride.mutateAsync().catch(() => {})}
              >
                Remove override
              </Button>
              {actions.setFreeLimit.error && (
                <p role="alert" className="text-sm text-destructive">
                  {actions.setFreeLimit.error.message}
                </p>
              )}
              {actions.removeFreeOverride.error && (
                <p role="alert" className="text-sm text-destructive">
                  {actions.removeFreeOverride.error.message}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3 text-sm">
              <Button
                variant="secondary"
                loading={actions.resetUsed.isPending}
                disabled={pending}
                onClick={() => void actions.resetUsed.mutateAsync("free").catch(() => {})}
              >
                Reset free
              </Button>
              <Button
                variant="secondary"
                loading={actions.resetUsed.isPending}
                disabled={pending}
                onClick={() => void actions.resetUsed.mutateAsync("paid").catch(() => {})}
              >
                Reset paid
              </Button>
              <Button
                variant="secondary"
                loading={actions.resetUsed.isPending}
                disabled={pending}
                onClick={() => void actions.resetUsed.mutateAsync("both").catch(() => {})}
              >
                Reset both
              </Button>
              <Button
                variant="secondary"
                loading={actions.recalculate.isPending}
                disabled={pending}
                onClick={() => void actions.recalculate.mutateAsync().catch(() => {})}
              >
                Recalculate
              </Button>
              {quota.scanBlocked ? (
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() => setDialog({ kind: "scanUnblock" })}
                >
                  Unblock scanning
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() => setDialog({ kind: "scanBlock" })}
                >
                  Block scanning
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Paid Grants</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {quota.paidGrants.length > 0 ? (
              <ul className="divide-y divide-border">
                {quota.paidGrants.map((grant) => (
                  <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {grant.remaining}/{grant.amount} remaining
                        </span>
                        <Badge variant={grantStatusVariant(grant.status)}>{grant.status}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Used {grant.used} &middot; Expires{" "}
                        {grant.expiresAt ? new Date(grant.expiresAt).toLocaleDateString() : "Never"}
                      </p>
                    </div>
                    {grant.status === "active" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        onClick={() => setDialog({ kind: "revokeGrant", grantId: grant.id })}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No paid grants.</p>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center">
              <Input
                type="number"
                min={1}
                placeholder="Amount"
                value={grantAmount}
                onChange={(e) => setGrantAmount(e.target.value)}
                className="sm:max-w-[10rem]"
              />
              <Input
                type="date"
                placeholder="Expiry (optional)"
                value={grantExpiry}
                onChange={(e) => setGrantExpiry(e.target.value)}
                className="sm:max-w-[12rem]"
              />
              <Button
                variant="primary"
                loading={actions.grantPaid.isPending}
                disabled={grantAmount === ""}
                onClick={() => void handleGrantPaid()}
              >
                Grant paid
              </Button>
            </div>
            {actions.grantPaid.error && (
              <p role="alert" className="text-sm text-destructive">
                {actions.grantPaid.error.message}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tier History</CardTitle>
          </CardHeader>
          <CardContent>
            <HistoryList
              entries={tierHistory.data?.data.entries ?? []}
              rowKey={(entry) => entry.id}
              renderEntry={(entry) => (
                <>
                  <div>
                    <span className="font-medium">
                      {(entry.previousTierName ?? "—") + " → " + (entry.tierName ?? "Removed")}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {entry.action} &middot; {entry.assignedBy ?? "—"}
                    </span>
                  </div>
                  <span className="text-muted-foreground">
                    {new Date(entry.assignedAt).toLocaleString()}
                  </span>
                </>
              )}
              meta={tierHistory.data?.meta.page ?? { total: 0, totalPages: 0, nextCursor: null, limit: 0 }}
              currentPage={tierStack.length}
              hasPrevious={tierStack.length > 1}
              onNext={() => {
                const next = tierHistory.data?.meta.page.nextCursor;
                if (next) setTierStack((s) => [...s, next]);
              }}
              onPrevious={() => setTierStack((s) => s.slice(0, -1))}
              emptyTitle="No tier history"
              emptyDescription="Tier assignments and removals for this user will appear here."
            />
          </CardContent>
        </Card>

        <AdminUserRequestsCard googleUserId={googleUserId} />

        <Card>
          <CardHeader>
            <CardTitle>Quota History</CardTitle>
          </CardHeader>
          <CardContent>
            <HistoryList
              entries={history.data?.data.entries ?? []}
              rowKey={(entry) => entry.id}
              renderEntry={(entry) => (
                <>
                  <div>
                    <span className="font-medium">{entry.kind}</span>
                    <span className="ml-2 text-muted-foreground">
                      {entry.pool ?? "—"}
                      {entry.delta !== null ? ` (${entry.delta > 0 ? "+" : ""}${entry.delta})` : ""}
                      {entry.reason ? ` · ${entry.reason}` : ""}
                    </span>
                  </div>
                  <span className="text-muted-foreground">{new Date(entry.ts).toLocaleString()}</span>
                </>
              )}
              meta={history.data?.meta.page ?? { total: 0, totalPages: 0, nextCursor: null, limit: 0 }}
              currentPage={historyStack.length}
              hasPrevious={historyStack.length > 1}
              onNext={() => {
                const next = history.data?.meta.page.nextCursor;
                if (next) setHistoryStack((s) => [...s, next]);
              }}
              onPrevious={() => setHistoryStack((s) => s.slice(0, -1))}
              emptyTitle="No quota history"
              emptyDescription="Grants, resets, and scan deductions for this user will appear here."
            />
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={dialog?.kind === "assignTier"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Assign tier?"
        description="This replaces the user's current tier. Their effective allowance is recalculated immediately."
        confirmLabel="Assign Tier"
        loading={actions.assignTier.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
      <ConfirmDialog
        open={dialog?.kind === "removeTier"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Remove tier?"
        description="The user reverts to the default Free allowance."
        confirmLabel="Remove Tier"
        destructive
        loading={actions.removeTier.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
      <ConfirmDialog
        open={dialog?.kind === "revokeGrant"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Revoke grant?"
        description="The remaining balance on this paid grant will be revoked immediately."
        confirmLabel="Revoke Grant"
        destructive
        loading={actions.revokeGrant.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
      <ConfirmDialog
        open={dialog?.kind === "scanBlock"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Block scanning?"
        description="The user stays signed in but is refused any new scans until unblocked."
        confirmLabel="Block scanning"
        destructive
        loading={actions.scanBlock.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
      <ConfirmDialog
        open={dialog?.kind === "scanUnblock"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Unblock scanning?"
        description="The user will be able to scan again, subject to their remaining allowance."
        confirmLabel="Unblock scanning"
        loading={actions.scanUnblock.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
    </PageContainer>
  );
}
