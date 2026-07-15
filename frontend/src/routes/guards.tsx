import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/features/auth/useAuth";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { ROUTES } from "@/shared/lib/constants";

/**
 * Announce a Session Revocation once, as the user is redirected to /login.
 *
 * Without this the user is silently thrown back to the login screen with no
 * idea why — the whole point of SESSION_REVOKED (over a plain 401) is to be
 * able to say "you signed in on another device". The ref guards against a
 * duplicate toast if the component re-renders before the redirect commits.
 */
function useSessionRevokedToast(revoked: boolean, message: string | undefined) {
  const announced = useRef(false);
  useEffect(() => {
    if (revoked && !announced.current) {
      announced.current = true;
      toast.info(message ?? "You were signed out because you signed in on another device");
    }
  }, [revoked, message]);
}

/**
 * Gates protected routes. While auth status is still loading we render the
 * splash (never a flash of the login screen). If the status *fetch itself*
 * fails (network/server error) we show a retryable error rather than treating
 * it as "logged out" and bouncing to /login — a failed request is not the same
 * as an unauthenticated user. Unauthenticated users are sent to /login.
 * `needsReconnect` users are allowed through — the app shell surfaces the
 * reconnect prompt where relevant (and the save step enforces it).
 */
export function ProtectedRoute() {
  const { isLoading, isError, authenticated, sessionRevoked, sessionRevokedMessage, refetch } =
    useAuth();
  const location = useLocation();

  useSessionRevokedToast(sessionRevoked, sessionRevokedMessage);

  if (isLoading) return <AppSplash message="Loading your workspace…" />;

  // Checked before isError: a revoked session is a definitive answer, not a
  // failure to get one. Showing the retryable "couldn't verify" state here
  // would offer a Retry button that can never succeed.
  if (sessionRevoked) {
    return <Navigate to={ROUTES.login} replace />;
  }

  if (isError) {
    return (
      <PageContainer width="narrow">
        <ErrorState
          title="Couldn’t verify your session"
          message="We couldn’t reach the server to check whether you’re signed in. Check your connection and try again."
          onRetry={() => void refetch()}
        />
      </PageContainer>
    );
  }
  if (!authenticated) {
    return <Navigate to={ROUTES.login} replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/**
 * For public-only routes (landing, login): once authenticated, bounce to the
 * dashboard. This is how the post-OAuth redirect to "/" lands the user in the
 * app without any query-param handshake.
 */
export function PublicOnly() {
  const { isLoading, authenticated } = useAuth();

  if (isLoading) return <AppSplash message="Signing you in…" />;
  if (authenticated) return <Navigate to={ROUTES.dashboard} replace />;
  return <Outlet />;
}
