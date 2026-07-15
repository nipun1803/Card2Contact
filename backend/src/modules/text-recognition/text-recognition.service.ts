import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardSession } from "../../shared/types/card-session";
import { OcrClient } from "./text-recognition.client";

/**
 * M2 — Text Recognition business rules (docs/modules/M2-Text-Recognition.md §4):
 * - Front and back images are recognized independently.
 * - Their raw text outputs are merged front-then-back into a single block.
 *
 * M2 owns only the `rawText` field of the session; it reads M1's image(s)
 * through the store and never touches other modules' fields. Front image is
 * always present (M1 populates it synchronously on create), so there is no
 * pipeline-order precondition to guard here.
 */
export class M2Service {
  constructor(
    private readonly store: CardSessionStore,
    private readonly ocr: OcrClient
  ) {}

  async recognize(cardId: string): Promise<CardSession> {
    // Throws CardNotFoundError automatically if the cardId is unknown.
    const session = this.store.get(cardId);

    // One OCR call per image (M2 §5: no repeated/N+1 calls).
    const frontText = await this.ocr.recognize(session.frontImage);

    // Back image only in double mode and only when M1 actually captured one.
    const backText =
      session.mode === "double" && session.backImage
        ? await this.ocr.recognize(session.backImage)
        : null;

    // Merge front-then-back into a single block before handoff to M3.
    const rawText = [frontText, backText]
      .filter((text): text is string => text !== null)
      .join("\n");

    return this.store.update(cardId, { rawText });
  }
}
