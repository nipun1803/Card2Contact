import { RECENT_SCANS_LIMIT } from "@/shared/lib/constants";
import type { Contact } from "@/shared/types/contact";

/**
 * Recent scans are kept only in localStorage — the backend does not persist
 * contacts (they go straight to the user's Google Sheet). This is a convenience
 * history for the dashboard, scoped per browser.
 */
const STORAGE_KEY = "c2c.recentScans";

export interface RecentScan {
  id: string;
  name: string;
  company: string;
  email: string;
  savedAt: string; // ISO timestamp
}

function read(): RecentScan[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentScan[]) : [];
  } catch {
    return [];
  }
}

export function getRecentScans(): RecentScan[] {
  return read();
}

/** Prepend a newly saved contact, de-duping is not needed (each save is new). */
export function addRecentScan(cardId: string, contact: Contact): RecentScan[] {
  const entry: RecentScan = {
    id: cardId,
    name: contact.name,
    company: contact.company,
    email: contact.email,
    savedAt: new Date().toISOString(),
  };
  const next = [entry, ...read()].slice(0, RECENT_SCANS_LIMIT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable (private mode) — history is best-effort.
  }
  return next;
}

export function clearRecentScans(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
