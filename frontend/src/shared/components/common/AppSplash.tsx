import { Logo } from "./Logo";
import { Spinner } from "./Spinner";

interface AppSplashProps {
  message?: string;
}

/**
 * Full-screen neutral splash shown while auth status resolves on first paint.
 * Prevents a flash of the login screen before we know whether the user is
 * signed in (important right after the OAuth redirect).
 */
export function AppSplash({ message = "Loading…" }: AppSplashProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <Logo />
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Spinner label={message} />
        <span>{message}</span>
      </div>
    </div>
  );
}
