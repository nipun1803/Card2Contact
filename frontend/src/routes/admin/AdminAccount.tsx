import { useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { useAdminAuth, useAdminAuthActions } from "@/features/admin/useAdminAuth";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { Row } from "@/shared/components/common/Row";
import { ThemeToggle } from "@/shared/components/common/ThemeToggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { ROUTES } from "@/shared/lib/constants";

/**
 * The admin's own account — identity, appearance, and Admin Session info.
 * Distinct from AdminLicenseSettings (global license config, not personal).
 * An Admin Session is never an Active Session; it shares no code path with
 * the user-facing Profile page. See docs/ARCHITECTURE.md's terminology table.
 */
export default function AdminAccount() {
  const { username } = useAdminAuth();
  const { logout } = useAdminAuthActions();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout.mutateAsync();
    navigate(ROUTES.adminLogin, { replace: true });
  }

  return (
    <PageContainer width="default">
      <div className="space-y-6">
        <PageHeader
          title="My Account"
          description="Your admin identity and preferences for this Admin Session."
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Admin" value={username ?? "—"} />
            <Row
              label="Session type"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="size-4 text-primary" aria-hidden />
                  Admin Session
                </span>
              }
            />
            <Row label="Absolute lifetime" value="8 hours" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preferences</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Appearance</p>
                <p className="text-sm text-muted-foreground">
                  Applies to the admin panel only, separate from the user-facing appearance setting.
                </p>
              </div>
              <ThemeToggle />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Session</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="secondary"
              onClick={() => void handleLogout()}
              disabled={logout.isPending}
            >
              {logout.isPending ? "Logging out…" : "Log out"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
