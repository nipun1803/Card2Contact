import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import { queryClient } from "@/shared/lib/queryClient";
import { Toaster } from "@/shared/components/ui/sonner";
import { ThemeProvider } from "./ThemeProvider";
import { ErrorFallback } from "./ErrorFallback";
import { router } from "./router";

/** Root component: providers + global error boundary + router + toaster. */
export function App() {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
