import { randomUUID } from "crypto";
import { CardSession, CardMode } from "../types/card-session";

export class CardNotFoundError extends Error {
  constructor(cardId: string) {
    super(`Card ${cardId} not found`);
    this.name = "CardNotFoundError";
  }
}

/**
 * The single interface modules use to hand off pipeline state to one
 * another. No module holds a reference to another module's service —
 * they only depend on this store.
 */
export interface CardSessionStore {
  create(mode: CardMode, frontImage: Buffer, backImage: Buffer | null): CardSession;
  get(cardId: string): CardSession;
  update(cardId: string, patch: Partial<CardSession>): CardSession;
}

export class InMemoryCardSessionStore implements CardSessionStore {
  private readonly sessions = new Map<string, CardSession>();

  create(mode: CardMode, frontImage: Buffer, backImage: Buffer | null): CardSession {
    const session: CardSession = {
      cardId: randomUUID(),
      mode,
      frontImage,
      backImage,
      rawText: null,
      contact: null,
      confirmed: false,
      saved: false,
    };
    this.sessions.set(session.cardId, session);
    return session;
  }

  get(cardId: string): CardSession {
    const session = this.sessions.get(cardId);
    if (!session) {
      throw new CardNotFoundError(cardId);
    }
    return session;
  }

  update(cardId: string, patch: Partial<CardSession>): CardSession {
    const session = this.get(cardId);
    const updated = { ...session, ...patch };
    this.sessions.set(cardId, updated);
    return updated;
  }
}

/**
 * Process-wide singleton. A modular monolith with a single in-memory store
 * means every module resolves the same instance rather than constructing
 * its own — mirroring how a real datastore would be shared across services.
 */
export const cardSessionStore: CardSessionStore = new InMemoryCardSessionStore();
