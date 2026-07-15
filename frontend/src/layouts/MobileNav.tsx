import { NavLink } from "react-router-dom";
import { LayoutDashboard, ScanLine, User } from "lucide-react";
import { cn } from "@/shared/utils/cn";
import { ROUTES } from "@/shared/lib/constants";

const items = [
  { to: ROUTES.dashboard, label: "Home", icon: LayoutDashboard },
  { to: ROUTES.scan, label: "Scan", icon: ScanLine },
  { to: ROUTES.profile, label: "Profile", icon: User },
];

/** Bottom tab bar for mobile (< md). Hidden on larger screens. */
export function MobileNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur-md md:hidden"
      aria-label="Primary"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around">
        {items.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              end
              className={({ isActive }) =>
                cn(
                  "flex min-h-[3.5rem] flex-col items-center justify-center gap-1 text-xs font-medium transition-colors focus-ring",
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
