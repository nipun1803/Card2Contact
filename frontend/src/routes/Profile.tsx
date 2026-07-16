import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Mail, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { ConfirmDialog } from "@/shared/components/common/ConfirmDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import { useAuth, useAuthActions } from "@/features/auth/useAuth";
import { SheetStatusCard } from "@/features/sheets/SheetStatusCard";
import { PlanCard } from "@/features/plan/PlanCard";
import { MyRequestsCard } from "@/features/plan/MyRequestsCard";
import { clearRecentScans } from "@/shared/services/recentScans";
import { ROUTES } from "@/shared/lib/constants";
import { initials } from "@/shared/utils/format";

/** Account & settings page. */
export default function Profile() {
  const { email } = useAuth();
  const { logout } = useAuthActions();
  const navigate = useNavigate();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate(ROUTES.login, { replace: true });
    } catch {
      toast.error("Could not sign out. Please try again.");
    } finally {
      setLoggingOut(false);
      setLogoutOpen(false);
    }
  }

  return (
    <PageContainer width="default">
      <PageHeader title="Account" description="Manage your connection and preferences." />

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Account */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signed in as</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center gap-4">
              <Avatar className="size-12">
                <AvatarFallback>{initials(email)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate font-medium">
                  <Mail className="size-4 text-muted-foreground" aria-hidden />
                  {email ?? "Google account"}
                </p>
                <p className="text-sm text-muted-foreground">Connected with Google</p>
              </div>
            </div>
            <Button variant="secondary" onClick={() => setLogoutOpen(true)}>
              <LogOut aria-hidden />
              Log out
            </Button>
          </CardContent>
        </Card>

        {/* Preferences */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preferences</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Recent scans</p>
                <p className="text-sm text-muted-foreground">Clear the local history on this device.</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearRecentScans();
                  toast.success("Recent scans cleared");
                }}
              >
                <Trash2 aria-hidden />
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Your Plan — scan allowance, tier, and upgrade requests */}
        <PlanCard />

        {/* Google Sheet */}
        <SheetStatusCard />

        {/* Full history of the user's own upgrade requests */}
        <MyRequestsCard />
      </div>

      <ConfirmDialog
        open={logoutOpen}
        onOpenChange={setLogoutOpen}
        title="Log out?"
        description="You’ll need to sign in with Google again to save more cards."
        confirmLabel="Log out"
        loading={loggingOut}
        onConfirm={handleLogout}
      />
    </PageContainer>
  );
}
