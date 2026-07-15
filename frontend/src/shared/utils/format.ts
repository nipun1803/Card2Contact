/** Human-friendly relative time (e.g. "2 minutes ago", "just now"). */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

/** First-name-ish greeting from an email address. */
export function nameFromEmail(email: string | null | undefined): string {
  if (!email) return "there";
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[.\-_]/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}

/** Two-letter initials for an avatar fallback. */
export function initials(value: string | null | undefined): string {
  if (!value) return "??";
  const clean = value.split("@")[0] ?? value;
  const parts = clean.split(/[.\-_\s]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}
