import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAdminUserActions, useAdminUserAudit, useAdminUserDetail } from "@/features/admin/useAdminUsers";
import { StatusBadge } from "@/shared/components/common/StatusBadge";
import { ConfirmDialog } from "@/shared/components/common/ConfirmDialog";
import { HistoryList } from "@/shared/components/common/HistoryList";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { Row } from "@/shared/components/common/Row";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { ROUTES, adminLicenseDetailPath } from "@/shared/lib/constants";
import { AUDIT_EVENT_LABELS } from "@/shared/lib/auditEventLabels";

type DialogKind = "disable" | "restore" | "forceLogout" | null;

/** User Details — profile, status, spreadsheet, session, and audit history. */
export default function AdminUserDetail() {
  const { googleUserId = "" } = useParams<{ googleUserId: string }>();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [auditCursorStack, setAuditCursorStack] = useState<(string | undefined)[]>([undefined]);
  const auditCursor = auditCursorStack[auditCursorStack.length - 1];

  const { data, isLoading, isError, error, refetch } = useAdminUserDetail(googleUserId);
  const audit = useAdminUserAudit(googleUserId, auditCursor);
  const actions = useAdminUserActions(googleUserId);

  if (isLoading) return <AppSplash message="Loading user…" />;

  if (isError || !data) {
    return (
      <PageContainer width="default">
        <ErrorState
          title="Couldn't load this user"
          message={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    );
  }

  const user = data.data;

  async function handleConfirm() {
    try {
      if (dialog === "disable") await actions.disable.mutateAsync();
      if (dialog === "restore") await actions.restore.mutateAsync();
      if (dialog === "forceLogout") await actions.forceLogout.mutateAsync();
      setDialog(null);
    } catch {
      // Error is surfaced via the mutation's own error state below; keep the
      // dialog open so the admin can see it and retry instead of it silently
      // closing (or silently doing nothing) on failure.
    }
  }

  const pending = actions.disable.isPending || actions.restore.isPending || actions.forceLogout.isPending;

  const dialogError =
    (dialog === "disable" && actions.disable.error) ||
    (dialog === "restore" && actions.restore.error) ||
    (dialog === "forceLogout" && actions.forceLogout.error) ||
    null;

  return (
    <PageContainer width="default">
      <div className="space-y-6">
        <Link
          to={ROUTES.adminUsers}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to User Directory
        </Link>

        <PageHeader
          title={user.email}
          description={user.googleUserId}
          actions={
            <>
              <Link
                to={adminLicenseDetailPath(user.googleUserId)}
                className="text-sm font-medium text-primary hover:underline"
              >
                Manage license
              </Link>
              <StatusBadge disabled={user.disabled} />
            </>
          }
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Registered" value={new Date(user.createdAt).toLocaleString()} />
              <Row
                label="Last login"
                value={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Never"}
              />
              <Row label="Total scans" value={String(user.savedContactsCount)} />
              {user.disabled ? (
                <>
                  <Row
                    label="Revoked at"
                    value={user.disabledAt ? new Date(user.disabledAt).toLocaleString() : "—"}
                  />
                  <Row label="Revoked by" value={user.disabledBy ?? "—"} />
                </>
              ) : (
                user.restoredAt && (
                  <>
                    <Row label="Last restored" value={new Date(user.restoredAt).toLocaleString()} />
                    <Row label="Restored by" value={user.restoredBy ?? "—"} />
                  </>
                )
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Spreadsheet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {user.spreadsheetTitle ? (
                <Row label="Title" value={user.spreadsheetTitle} />
              ) : (
                <p className="text-muted-foreground">No spreadsheet provisioned yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Session</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {user.activeSession ? (
                <>
                  <Row label="Device" value={user.activeSession.device ?? "Unknown"} />
                  <Row label="Browser" value={user.activeSession.browser ?? "Unknown"} />
                  <Row
                    label="Last active"
                    value={new Date(user.activeSession.lastActivityAt).toLocaleString()}
                  />
                </>
              ) : (
                <p className="text-muted-foreground">No active session.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Account Management</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              {user.disabled ? (
                <Button variant="primary" onClick={() => setDialog("restore")} disabled={pending}>
                  Restore Access
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => setDialog("disable")} disabled={pending}>
                  Revoke Access
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => setDialog("forceLogout")}
                disabled={pending || !user.activeSession}
              >
                Force Logout
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Audit History</CardTitle>
          </CardHeader>
          <CardContent>
            <HistoryList
              entries={audit.data?.data.entries ?? []}
              rowKey={(entry) => entry.id}
              renderEntry={(entry) => (
                <>
                  <span>{AUDIT_EVENT_LABELS[entry.event] ?? entry.event}</span>
                  <span className="text-muted-foreground">{new Date(entry.ts).toLocaleString()}</span>
                </>
              )}
              meta={audit.data?.meta.page ?? { total: 0, totalPages: 0, nextCursor: null, limit: 0 }}
              currentPage={auditCursorStack.length}
              hasPrevious={auditCursorStack.length > 1}
              onNext={() => {
                const next = audit.data?.meta.page.nextCursor;
                if (next) setAuditCursorStack((s) => [...s, next]);
              }}
              onPrevious={() => setAuditCursorStack((s) => s.slice(0, -1))}
              emptyTitle="No audit history"
              emptyDescription="Activity for this user (logins, revokes, reconnects, saves) will appear here."
            />
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Revoke access?"
        description={`${user.email} will be signed out immediately and unable to sign in again until restored.`}
        confirmLabel="Revoke Access"
        destructive
        loading={actions.disable.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
      <ConfirmDialog
        open={dialog === "restore"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Restore access?"
        description={`${user.email} will be able to sign in again.`}
        confirmLabel="Restore Access"
        loading={actions.restore.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
      <ConfirmDialog
        open={dialog === "forceLogout"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Force logout?"
        description={`${user.email}'s current session will be ended immediately. They can sign back in right away.`}
        confirmLabel="Force Logout"
        destructive
        loading={actions.forceLogout.isPending}
        errorMessage={dialogError ? dialogError.message : null}
        onConfirm={() => void handleConfirm()}
      />
    </PageContainer>
  );
}
