import { Link, Outlet } from "react-router-dom";
import { Logo } from "@/shared/components/common/Logo";
import { Button } from "@/shared/components/ui/button";
import { OfflineBanner } from "@/shared/components/common/OfflineBanner";
import { ROUTES } from "@/shared/lib/constants";

/** Public shell for landing + login: slim transparent top bar, roomy content. */
export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <OfflineBanner />
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to={ROUTES.landing} className="rounded-md focus-ring" aria-label="Card2Contact home">
          <Logo />
        </Link>
        <Button asChild variant="ghost" size="sm">
          <Link to={ROUTES.login}>Sign in</Link>
        </Button>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-border py-6">
        <p className="mx-auto max-w-6xl px-4 text-center text-xs text-muted-foreground sm:px-6">
          © {new Date().getFullYear()} Card2Contact · Scan cards straight into your Google Sheet.
        </p>
      </footer>
    </div>
  );
}
