import { useNavigate } from "react-router-dom";
import { useAdminAuth, useAdminAuthActions } from "@/features/admin/useAdminAuth";
import { Button } from "@/shared/components/ui/button";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { ROUTES } from "@/shared/lib/constants";

/**
 * Phase 0.1 placeholder — the redirect target after admin login.
 *
 * Deliberately minimal: the username and the logout button are not decoration,
 * they are the only client-observable proof that GET /api/admin/auth/me and
 * POST /api/admin/auth/logout work end-to-end, and they give the E2E suite a
 * stable target. Everything else (nav, layout, actual admin tooling) is Phase
 * 0.2+ and would only be thrown away.
 *
 * No AppLayout: that shell renders the user-facing nav and assumes a Google
 * session, which an operator may not have.
 */
export default function AdminDashboard() {
  const { username } = useAdminAuth();
  const { logout } = useAdminAuthActions();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout.mutateAsync();
    navigate(ROUTES.adminLogin, { replace: true });
  }

  return (
    <PageContainer width="narrow">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{username}</span>
          </p>
        </div>

        <Button variant="secondary" onClick={() => void handleLogout()} disabled={logout.isPending}>
          {logout.isPending ? "Logging out…" : "Log out"}
        </Button>
      </div>
    </PageContainer>
  );
}
