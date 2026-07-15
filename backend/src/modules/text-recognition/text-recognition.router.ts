import { Router } from "express";
import { M2Service } from "./text-recognition.service";
import { createMistralOcrClient, OcrClient } from "./text-recognition.client";
import { CardSessionStore } from "../../shared/store/card-session-store";

/**
 * The OCR client (and its MISTRAL_API_KEY requirement) is built lazily on first
 * use, not at router construction — so `createApp` boots (and unit-tests) even
 * without the key, and only an actual /recognize call needs it. Mirrors how M5
 * defers its Google client. `makeOcrClient` is injectable for tests.
 */
export function createM2Router(
  store: CardSessionStore,
  makeOcrClient: () => OcrClient = createMistralOcrClient,
): Router {
  const router = Router();

  let ocr: OcrClient | undefined; // memoized after first use
  const getService = () => new M2Service(store, (ocr ??= makeOcrClient()));

  // POST /api/cards/:cardId/recognize — docs/modules/M2-Text-Recognition.md §5
  router.post("/cards/:cardId/recognize", async (req, res, next) => {
    try {
      const session = await getService().recognize(req.params.cardId);
      res.status(200).json({ cardId: session.cardId, rawText: session.rawText });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
