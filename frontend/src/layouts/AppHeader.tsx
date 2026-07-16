import { Link, useNavigate } from "react-router-dom";
import { LogOut, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/shared/components/common/Logo";
import { ConfirmDialog } from "@/shared/components/common/ConfirmDialog";
import { ThemeToggle } from "@/shared/components/common/ThemeToggle";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { useAuth, useAuthActions } from "@/features/auth/useAuth";
import { ROUTES } from "@/shared/lib/constants";
import { initials } from "@/shared/utils/format";

/** Authenticated top bar: brand + account menu (profile, logout). */
export function AppHeader() {
  const { email } = useAuth();
  const { logout } = useAuthActions();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      toast.success("Signed out");
      navigate(ROUTES.login, { replace: true });
    } catch {
      toast.error("Could not sign out. Please try again.");
    } finally {
      setLoggingOut(false);
      setConfirmOpen(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to={ROUTES.dashboard} className="rounded-md focus-ring" aria-label="Go to dashboard">
          <Logo />
        </Link>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-label="Account menu"
            >
              <Avatar>
                <AvatarFallback>{initials(email)}</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="truncate">{email ?? "Signed in"}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to={ROUTES.profile}>
                  <User aria-hidden />
                  Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive"
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirmOpen(true);
                }}
              >
                <LogOut aria-hidden />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Log out?"
        description="You’ll need to sign in with Google again to save more cards."
        confirmLabel="Log out"
        loading={loggingOut}
        onConfirm={handleLogout}
      />
    </header>
  );
}
