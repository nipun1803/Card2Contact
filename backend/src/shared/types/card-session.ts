import { Contact } from "./contact";

export type CardMode = "single" | "double";

/**
 * The single in-memory record a card passes through as it moves down the
 * M1 -> M5 pipeline. Each module owns and mutates only the fields its own
 * documentation assigns it — see the "owner" notes below. Modules must not
 * reach into another module's fields directly; they go through
 * CardSessionStore, which is the only inter-module interface.
 */
export interface CardSession {
  cardId: string;

  // Owned by M1 (Image Acquisition)
  mode: CardMode;
  frontImage: Buffer;
  backImage: Buffer | null;

  // Owned by M2 (Text Recognition)
  rawText: string | null;

  // Owned by M3 (Contact Extraction) / edited by M4 (Contact Review)
  contact: Contact | null;

  // Owned by M4 (Contact Review)
  confirmed: boolean;

  // Owned by M5 (Google Sheets Integration)
  saved: boolean;
}

/** Pipeline stages, used to report "which prior step is missing" in 409 errors. */
export enum PipelineStage {
  Created = "created",
  Recognized = "recognized",
  Extracted = "extracted",
  Confirmed = "confirmed",
  Saved = "saved",
}
