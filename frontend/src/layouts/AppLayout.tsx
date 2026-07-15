import { Outlet } from "react-router-dom";
import { AppHeader } from "./AppHeader";
import { MobileNav } from "./MobileNav";
import { OfflineBanner } from "@/shared/components/common/OfflineBanner";

/** Authenticated shell: sticky header, page outlet, mobile bottom nav. */
export function AppLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <OfflineBanner />
      <AppHeader />
      {/* Bottom padding leaves room for the mobile nav bar. */}
      <main className="flex-1 pb-20 md:pb-0">
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
}
