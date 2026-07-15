import { Link } from "react-router-dom";
import { Logo } from "@/shared/components/common/Logo";
import { Button } from "@/shared/components/ui/button";
import { ROUTES } from "@/shared/lib/constants";

/** 404 page. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <Logo />
      <div className="space-y-2">
        <p className="font-serif text-6xl font-semibold text-primary">404</p>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="max-w-sm text-muted-foreground">
          The page you’re looking for doesn’t exist or may have moved.
        </p>
      </div>
      <Button asChild>
        <Link to={ROUTES.dashboard}>Back to dashboard</Link>
      </Button>
    </div>
  );
}
