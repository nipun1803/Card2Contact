import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { BarChart3, FileText, Gauge, Inbox, Layers, LogOut, Settings2, User, Users } from "lucide-react";
import { useState } from "react";
import { useAdminAuth, useAdminAuthActions } from "@/features/admin/useAdminAuth";
import { useUpgradeRequestCount } from "@/features/admin/useAdminLicenses";
import { Logo } from "@/shared/components/common/Logo";
import { ConfirmDialog } from "@/shared/components/common/ConfirmDialog";
import { ThemeToggle } from "@/shared/components/common/ThemeToggle";
import { Badge } from "@/shared/components/ui/badge";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { ThemeProvider } from "@/app/ThemeProvider";
import { ROUTES } from "@/shared/lib/constants";
import { cn } from "@/shared/utils/cn";
import { initials } from "@/shared/utils/format";

const ADMIN_THEME_STORAGE_KEY = "c2c.admin-theme";

interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to?: string;
}

/**
 * The real nav item, plus four DISABLED placeholders for planned-but-not-built
 * surfaces (see docs/modules/admin/USER_MANAGEMENT.md's "Out of Scope and
 * Roadmap" section). These are deliberately inert:
 * no route, no lazy import, no component — a greyed-out label with a "Coming
 * soon" cue communicates "more is planned" without shipping any
 * non-functional page, which the user explicitly asked NOT to do. Nothing
 * here is clickable, nothing 404s, nothing calls a fake backend.
 */
const NAV_ITEMS: NavItem[] = [
  { label: "Users", icon: Users, to: ROUTES.adminUsers },
  { label: "Licenses", icon: Gauge, to: ROUTES.adminLicenses },
  { label: "Tiers", icon: Layers, to: ROUTES.adminTiers },
  { label: "Requests", icon: Inbox, to: ROUTES.adminRequests },
  { label: "License Settings", icon: Settings2, to: ROUTES.adminLicenseSettings },
  { label: "Analytics", icon: BarChart3 },
  { label: "Logs", icon: FileText },
];

/**
 * Admin shell: nav + header, wrapping an <Outlet/> for the User Directory and
 * User Details pages. Evolved from the Phase 0.1 placeholder (its own comment
 * anticipated this — "everything else is Phase 0.2+").
 *
 * Still no AppLayout: that shell renders the user-facing nav and assumes a
 * Google session, which an operator may not have.
 */
export default function AdminDashboard() {
  const { username } = useAdminAuth();
  const { logout } = useAdminAuthActions();
  const navigate = useNavigate();
  const { data: requestCount } = useUpgradeRequestCount();
  const pendingRequests = requestCount?.data.pendingCount ?? 0;
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleLogout() {
    await logout.mutateAsync();
    navigate(ROUTES.adminLogin, { replace: true });
  }

  return (
    <ThemeProvider storageKey={ADMIN_THEME_STORAGE_KEY}>
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 pt-4 sm:px-6">
          <Link to={ROUTES.adminUsers} className="flex items-center gap-2.5 rounded-md focus-ring" aria-label="Go to admin users">
            <Logo />
            <Badge variant="outline" className="uppercase tracking-wide">
              Admin
            </Badge>
          </Link>

          <div className="flex items-center gap-1">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label="Account menu"
              >
                <Avatar>
                  <AvatarFallback>{initials(username)}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="truncate">{username ?? "Signed in"}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to={ROUTES.adminAccount}>
                    <User aria-hidden />
                    Account
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

          <nav className="flex w-full flex-wrap items-center gap-1 overflow-x-auto pb-3">
            {NAV_ITEMS.map((item) =>
              item.to ? (
                <NavLink
                  key={item.label}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )
                  }
                >
                  <item.icon className="size-4" />
                  {item.label}
                  {item.to === ROUTES.adminRequests && pendingRequests > 0 && (
                    <span
                      aria-label={`${pendingRequests} pending`}
                      className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
                    >
                      {pendingRequests}
                    </span>
                  )}
                </NavLink>
              ) : (
                <span
                  key={item.label}
                  title="Coming soon"
                  aria-disabled="true"
                  className="flex shrink-0 cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/50"
                >
                  <item.icon className="size-4" />
                  {item.label}
                  <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                    Soon
                  </span>
                </span>
              ),
            )}
          </nav>
        </div>
      </header>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Log out?"
        description="You’ll need to sign in again to access the admin console."
        confirmLabel="Log out"
        loading={logout.isPending}
        onConfirm={handleLogout}
      />

      <Outlet />
    </div>
    </ThemeProvider>
  );
}
