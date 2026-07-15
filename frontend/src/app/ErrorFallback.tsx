import type { FallbackProps } from "react-error-boundary";
import { Logo } from "@/shared/components/common/Logo";
import { ErrorState } from "@/shared/components/common/ErrorState";

/**
 * Top-level error boundary fallback. Catches render-time crashes anywhere in
 * the tree and offers a recovery action that resets the boundary.
 */
export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background px-6">
      <Logo />
      <ErrorState
        title="This page hit a snag"
        message={error instanceof Error ? error.message : "An unexpected error occurred."}
        onRetry={resetErrorBoundary}
        retryLabel="Reload"
        className="w-full max-w-md"
      />
    </div>
  );
}
