import { vi } from "vitest";
import { CardSession } from "../../src/shared/types/card-session";
import {
  CardNotFoundError,
  CardSessionStore,
} from "../../src/shared/store/card-session-store";
import { UserRecord, UserStore, TokenSet } from "../../src/shared/store/user-store";
import {
  PENDING_TTL_MS,
  PendingSessionRecord,
  RevokeReason,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SessionFingerprint,
  SessionRecord,
  SessionStore,
  newSessionId,
} from "../../src/shared/store/session-store";
import { SheetsClient } from "../../src/modules/google-sheets/google-sheets.client";
import { SheetsProvisioner } from "../../src/shared/sheets/sheets-provisioner";
import { OcrClient } from "../../src/modules/text-recognition/text-recognition.client";
import { SHEET_HEADER } from "../../src/modules/google-sheets/google-sheets.service";

/**
 * A working in-memory CardSessionStore backed by a Map — behaves like the real
 * InMemoryCardSessionStore but lets a test seed sessions directly and spy on
 * calls. Prefer this over hand-rolling `vi.fn()` stubs when a test drives more
 * than one pipeline step.
 */
export function makeCardStore(seed: CardSession[] = []): CardSessionStore & {
  _map: Map<string, CardSession>;
} {
  const map = new Map<string, CardSession>(seed.map((s) => [s.cardId, s]));
  return {
    _map: map,
    create: vi.fn((mode, frontImage, backImage) => {
      const session: CardSession = {
        cardId: `card-${map.size + 1}`,
        mode,
        frontImage,
        backImage,
        rawText: null,
        contact: null,
        confirmed: false,
        saved: false,
      };
      map.set(session.cardId, session);
      return session;
    }),
    get: vi.fn((id: string) => {
      const s = map.get(id);
      if (!s) throw new CardNotFoundError(id);
      return s;
    }),
    update: vi.fn((id: string, patch: Partial<CardSession>) => {
      const s = map.get(id);
      if (!s) throw new CardNotFoundError(id);
      const next = { ...s, ...patch };
      map.set(id, next);
      return next;
    }),
  };
}

/** Fully-stubbed UserStore; override any method per test. */
export function makeUserStore(overrides: Partial<UserStore> = {}): UserStore {
  return {
    findById: vi.fn(async () => null),
    upsertOnLogin: vi.fn(async (input) => ({
      googleUserId: input.googleUserId,
      email: input.email,
      spreadsheetId: null,
      spreadsheetUrl: null,
      spreadsheetTitle: null,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      tokenExpiry: input.tokenExpiry,
      savedContactsCount: 0,
    })),
    updateTokens: vi.fn(async () => {}),
    setSpreadsheet: vi.fn(async () => {}),
    clearTokens: vi.fn(async () => {}),
    incrementSavedContactsCount: vi.fn(async () => 1),
    ...overrides,
  };
}

/** A complete UserRecord; override any field. Keeps specs from drifting as the
 *  record grows new fields. */
export function makeUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    googleUserId: "u1",
    email: "ada@example.com",
    spreadsheetId: "sheet-1",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
    spreadsheetTitle: "Card2Contact Contacts",
    accessToken: "at",
    refreshToken: "rt",
    tokenExpiry: null,
    savedContactsCount: 0,
    ...overrides,
  };
}

/** A stored session, with the revocation state the fake needs to model. */
interface StoredSession extends SessionRecord {
  revokedAt: Date | null;
  revokedReason: RevokeReason | null;
}

interface StoredPending extends PendingSessionRecord {
  expiresAt: Date;
}

/**
 * A working in-memory SessionStore backed by Maps.
 *
 * Follows makeCardStore's approach (real behaviour) rather than makeUserStore's
 * (vi.fn stubs): session tests drive multi-step flows — sign in, hit a Session
 * Conflict, continue, watch the old device get revoked — where stubs would make
 * every test re-specify the whole state machine.
 *
 * It reimplements the Active predicate that PgSessionStore expresses in SQL, so
 * this fake is also where the behavioural proof of the lifetime bounds lives
 * (PgSessionStore's own tests can only assert the bounds are bound as params,
 * since the time logic runs inside Postgres).
 *
 * Timestamps are injectable via `_now` so tests can age a session without
 * sleeping.
 */
export function makeSessionStore(): SessionStore & {
  _sessions: Map<string, StoredSession>;
  _pending: Map<string, StoredPending>;
  /** Override "now" to age sessions in tests. */
  _now: () => Date;
  _setNow: (fn: () => Date) => void;
  /** Seed a session with explicit timestamps. */
  _seed: (session: Partial<StoredSession> & { googleUserId: string }) => StoredSession;
} {
  const sessions = new Map<string, StoredSession>();
  const pending = new Map<string, StoredPending>();
  let now = () => new Date();

  const isActive = (s: StoredSession): boolean => {
    const t = now().getTime();
    return (
      s.revokedAt === null &&
      t - s.lastActivityAt.getTime() < SESSION_IDLE_MS &&
      t - s.createdAt.getTime() < SESSION_ABSOLUTE_MS
    );
  };

  const store = {
    _sessions: sessions,
    _pending: pending,
    _now: () => now(),
    _setNow: (fn: () => Date) => {
      now = fn;
    },
    _seed: (input: Partial<StoredSession> & { googleUserId: string }): StoredSession => {
      const session: StoredSession = {
        id: input.id ?? newSessionId(),
        googleUserId: input.googleUserId,
        device: input.device ?? "macOS",
        browser: input.browser ?? "Chrome",
        ip: input.ip ?? "203.0.113.1",
        createdAt: input.createdAt ?? now(),
        lastActivityAt: input.lastActivityAt ?? now(),
        revokedAt: input.revokedAt ?? null,
        revokedReason: input.revokedReason ?? null,
      };
      sessions.set(session.id, session);
      return session;
    },

    create: vi.fn(async (googleUserId: string, fp: SessionFingerprint) => {
      const session: StoredSession = {
        id: newSessionId(),
        googleUserId,
        device: fp.device,
        browser: fp.browser,
        ip: fp.ip,
        createdAt: now(),
        lastActivityAt: now(),
        revokedAt: null,
        revokedReason: null,
      };
      sessions.set(session.id, session);
      return toRecord(session);
    }),

    findActive: vi.fn(async (id: string) => {
      const s = sessions.get(id);
      return s && isActive(s) ? toRecord(s) : null;
    }),

    findActiveForUser: vi.fn(async (googleUserId: string) => {
      const matches = [...sessions.values()]
        .filter((s) => s.googleUserId === googleUserId && isActive(s))
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      return matches.length ? toRecord(matches[0]) : null;
    }),

    // Deliberately independent of the lifetime bounds: an expired-then-revoked
    // session must still report as revoked.
    isRevoked: vi.fn(async (id: string) => sessions.get(id)?.revokedAt != null),

    touch: vi.fn(async (id: string) => {
      const s = sessions.get(id);
      if (s && s.revokedAt === null) s.lastActivityAt = now();
    }),

    revoke: vi.fn(async (id: string, reason: RevokeReason) => {
      const s = sessions.get(id);
      // First revocation wins, matching the SQL's `revoked_at IS NULL` guard.
      if (s && s.revokedAt === null) {
        s.revokedAt = now();
        s.revokedReason = reason;
      }
    }),

    revokeAllForUser: vi.fn(async (googleUserId: string, reason: RevokeReason) => {
      let count = 0;
      for (const s of sessions.values()) {
        if (s.googleUserId === googleUserId && s.revokedAt === null) {
          s.revokedAt = now();
          s.revokedReason = reason;
          count++;
        }
      }
      return count;
    }),

    createPending: vi.fn(async (googleUserId: string, fp: SessionFingerprint) => {
      const record: StoredPending = {
        id: newSessionId(),
        googleUserId,
        device: fp.device,
        browser: fp.browser,
        ip: fp.ip,
        expiresAt: new Date(now().getTime() + PENDING_TTL_MS),
      };
      pending.set(record.id, record);
      return { ...record };
    }),

    consumePending: vi.fn(async (id: string) => {
      const p = pending.get(id);
      // Delete-on-read, matching DELETE ... RETURNING: a second Continue click
      // must not find it.
      pending.delete(id);
      if (!p || p.expiresAt.getTime() <= now().getTime()) return null;
      const { expiresAt: _expiresAt, ...record } = p;
      return record;
    }),

    purgeExpired: vi.fn(async () => {
      let purgedSessions = 0;
      for (const [id, s] of sessions) {
        const expired =
          s.revokedAt === null && !isActive(s);
        if (expired) {
          sessions.delete(id);
          purgedSessions++;
        }
      }
      let purgedPending = 0;
      for (const [id, p] of pending) {
        if (p.expiresAt.getTime() < now().getTime()) {
          pending.delete(id);
          purgedPending++;
        }
      }
      return { sessions: purgedSessions, pending: purgedPending };
    }),
  };

  return store;
}

function toRecord(s: StoredSession): SessionRecord {
  return {
    id: s.id,
    googleUserId: s.googleUserId,
    device: s.device,
    browser: s.browser,
    ip: s.ip,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
  };
}

/** Sheets client whose header read matches the canonical header by default. */
export function makeSheetsClient(overrides: Partial<SheetsClient> = {}): SheetsClient {
  return {
    appendRow: vi.fn(async () => {}),
    createSpreadsheetWithHeader: vi.fn(async () => "new-sheet-id"),
    readHeader: vi.fn(async () => [...SHEET_HEADER]),
    writeHeader: vi.fn(async () => {}),
    // Healthy sheet by default; override to drive the Recreate Sheet path.
    isTrashed: vi.fn(async () => false),
    ...overrides,
  };
}

export function makeProvisioner(spreadsheetId = "provisioned-sheet"): SheetsProvisioner {
  return { ensureSpreadsheet: vi.fn(async () => spreadsheetId) };
}

/** OCR client that returns canned text per image, or a fixed string. */
export function makeOcrClient(text: string | ((image: Buffer) => string) = "OCR TEXT"): OcrClient {
  return {
    recognize: vi.fn(async (image: Buffer) =>
      typeof text === "function" ? text(image) : text,
    ),
  };
}

export type { UserRecord, TokenSet };
