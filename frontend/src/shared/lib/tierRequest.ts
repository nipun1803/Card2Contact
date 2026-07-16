import type { TierRequest, TierRequestStatus } from "@/shared/types/api";

/** "Enterprise" or "Custom: 50 scans, 30 days" — what the user actually asked for. */
export function describeRequestAsk(r: TierRequest): string {
  if (r.kind === "tier") return r.requestedTierName ?? `Tier #${r.requestedTierId ?? "?"}`;
  const parts: string[] = [];
  if (r.requestedAmount != null) parts.push(`${r.requestedAmount} scans`);
  if (r.requestedDays != null) parts.push(`${r.requestedDays} days`);
  return parts.length ? `Custom: ${parts.join(", ")}` : "Custom request";
}

export const REQUEST_STATUS_BADGE_VARIANT: Record<TierRequestStatus, "warning" | "success" | "outline"> = {
  pending: "warning",
  approved: "success",
  rejected: "outline",
};

export const REQUEST_STATUS_LABEL: Record<TierRequestStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};
