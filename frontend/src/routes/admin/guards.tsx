import { Navigate, Outlet } from "react-router-dom";
import { useAdminAuth } from "@/features/admin/useAdminAuth";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { ROUTES } from "@/shared/lib/constants";

/**
 * Gates the admin area on an Admin Session.
 *
 * Deliberately a separate file from routes/guards.tsx, and deliberately calls
 * useAdminAuth and NEVER useAuth: the two identities are unrelated. An operator
 * need not be a signed-in Google user, and a signed-in Google user is certainly
 * not an admin — keeping them in one file is how someone eventually reaches for
 * the wrong hook.
 *
 * See docs/modules/admin/Admin-Authentication.md.
 */
export function AdminProtectedRoute() {
  const { isLoading, isError, authenticated, refetch } = useAdminAuth();

  if (isLoading) return <AppSplash message="Checking admin access…" />;

  /**
   * A failed *fetch* is not a signed-out admin. Bouncing to /admin/login here
   * would tell an operator their session ended when in fact the server is
   * unreachable — the same reasoning as ProtectedRoute's error branch. A 401 is
   * NOT this case: useAdminAuth classifies it as authenticated:false, below.
   */
  if (isError) {
    return (
      <PageContainer width="narrow">
        <ErrorState
          title="Couldn’t verify admin access"
          message="We couldn’t reach the server to check your admin session. Check your connection and try again."
          onRetry={() => void refetch()}
        />
      </PageContainer>
    );
  }

  if (!authenticated) return <Navigate to={ROUTES.adminLogin} replace />;

  return <Outlet />;
}
