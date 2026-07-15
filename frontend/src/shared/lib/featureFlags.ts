/**
 * Central feature flags. Each defaults to enabled and can be turned off for
 * testing via a VITE_FLAG_* env var (e.g. VITE_FLAG_CAMERA=false). Read through
 * the useFeatureFlag hook so components stay declarative.
 */
export type FeatureFlag =
  | "camera"
  | "upload"
  | "googleOAuth"
  | "darkMode"
  | "animations"
  | "recentScans";

function flag(envValue: string | undefined, fallback = true): boolean {
  if (envValue === undefined) return fallback;
  return envValue !== "false" && envValue !== "0";
}

const env = import.meta.env;

export const featureFlags: Record<FeatureFlag, boolean> = {
  camera: flag(env.VITE_FLAG_CAMERA),
  upload: flag(env.VITE_FLAG_UPLOAD),
  googleOAuth: flag(env.VITE_FLAG_GOOGLE_OAUTH),
  darkMode: flag(env.VITE_FLAG_DARK_MODE),
  animations: flag(env.VITE_FLAG_ANIMATIONS),
  recentScans: flag(env.VITE_FLAG_RECENT_SCANS),
};

export function isFeatureEnabled(name: FeatureFlag): boolean {
  return featureFlags[name];
}
