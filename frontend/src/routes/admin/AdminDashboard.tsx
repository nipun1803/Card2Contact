import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { BarChart3, FileText, Settings2, Users } from "lucide-react";
import { useAdminAuth, useAdminAuthActions } from "@/features/admin/useAdminAuth";
import { Button } from "@/shared/components/ui/button";
import { ROUTES } from "@/shared/lib/constants";
import { cn } from "@/shared/utils/cn";

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
  { label: "Analytics", icon: BarChart3 },
  { label: "Configuration", icon: Settings2 },
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

  async function handleLogout() {
    await logout.mutateAsync();
    navigate(ROUTES.adminLogin, { replace: true });
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 sm:px-6">
          <span className="text-lg font-semibold tracking-tight">Card2Contact Admin</span>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              Signed in as <span className="font-medium text-foreground">{username}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => void handleLogout()} disabled={logout.isPending}>
              {logout.isPending ? "Logging out…" : "Log out"}
            </Button>
          </div>
          <nav className="flex w-full flex-wrap items-center gap-1 overflow-x-auto">
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
      <Outlet />
    </div>
  );
}
