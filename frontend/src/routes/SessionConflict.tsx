import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { cancelSession, continueSession } from "@/shared/services/api";
import { useAuthActions } from "@/features/auth/useAuth";
import { ROUTES } from "@/shared/lib/constants";
import { timeAgo } from "@/shared/utils/format";

/**
 * Session Conflict prompt — card2contact allows one Active Session per account,
 * so signing in here means signing the other device out.
 *
 * The backend's OAuth callback redirects here when it finds an existing Active
 * Session, having staged a Pending Session in a short-lived cookie rather than
 * activating this one. Continue calls the backend, which revokes the old
 * session and activates ours; Cancel discards the pending sign-in and leaves
 * the other device alone.
 *
 * The device details in the query string are DISPLAY ONLY — the backend
 * re-reads the pending cookie server-side and never trusts anything here.
 *
 * Deliberately a full-page card rather than a ConfirmDialog: this is a
 * redirect destination with nothing behind it to overlay.
 */
export default function SessionConflict() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refreshAuth } = useAuthActions();
  const [busy, setBusy] = useState<"continue" | "cancel" | null>(null);

  const device = params.get("device") ?? "Unknown device";
  const browser = params.get("browser") ?? "Unknown browser";
  const lastActive = params.get("lastActive");

  async function handleContinue() {
    setBusy("continue");
    try {
      await continueSession();
      // The pending session is now the Active Session; drop the cached
      // authenticated:false so the guard sees the new state and lets us in.
      await refreshAuth();
      navigate(ROUTES.dashboard, { replace: true });
    } catch {
      // Almost always an expired Pending Session (5 min) — signing in again is
      // the only route forward, so send them back rather than stranding them
      // on a page whose only action no longer works.
      toast.error("That sign-in request expired. Please sign in again.");
      navigate(ROUTES.login, { replace: true });
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel() {
    setBusy("cancel");
    try {
      await cancelSession();
    } catch {
      // Cancel is idempotent server-side and the pending session expires on its
      // own regardless, so a failure here changes nothing the user cares about.
    } finally {
      setBusy(null);
      navigate(ROUTES.login, { replace: true });
    }
  }

  return (
    <PageContainer width="narrow">
      <Card className="mx-auto max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-5 p-8">
          <span className="flex size-14 items-center justify-center rounded-full bg-warning/15 text-warning-foreground">
            <MonitorSmartphone className="size-6" aria-hidden />
          </span>

          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold">You’re signed in somewhere else</h1>
            <p className="text-sm text-muted-foreground">
              Your account is currently signed in on another device. Card2Contact allows one
              device at a time, so continuing here will sign that one out.
            </p>
          </div>

          <div className="w-full rounded-lg border border-border bg-muted/40 p-4 text-left">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Other device
            </p>
            <p className="mt-1 text-sm font-medium">
              {browser} on {device}
            </p>
            {lastActive && (
              <p className="text-xs text-muted-foreground">Last active {timeAgo(lastActive)}</p>
            )}
          </div>

          <div className="flex w-full flex-col gap-2">
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void handleContinue()}
              loading={busy === "continue"}
              disabled={busy !== null}
            >
              Continue and sign out the other device
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => void handleCancel()}
              loading={busy === "cancel"}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
