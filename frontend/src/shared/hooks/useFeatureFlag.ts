import { featureFlags, type FeatureFlag } from "@/shared/lib/featureFlags";

/** Read a feature flag declaratively inside components. */
export function useFeatureFlag(name: FeatureFlag): boolean {
  return featureFlags[name];
}
