import { useMediaQuery } from "./useMediaQuery";
import { isFeatureEnabled } from "@/shared/lib/featureFlags";

/**
 * True when motion should be suppressed — either the OS "reduce motion" setting
 * is on, or the `animations` feature flag is disabled. Components gate Framer
 * Motion transitions on this so animation can be turned off wholesale.
 */
export function usePrefersReducedMotion(): boolean {
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  return systemReduced || !isFeatureEnabled("animations");
}
