import { Router } from "express";
import { M3Service } from "./contact-extraction.service";
import { CardSessionStore } from "../../shared/store/card-session-store";

export function createM3Router(store: CardSessionStore): Router {
  const service = new M3Service(store);
  const router = Router();

  // POST /api/cards/:cardId/extract — docs/modules/M3-Contact-Extraction.md §5
  router.post("/cards/:cardId/extract", (req, res, next) => {
    try {
      const { cardId } = req.params;
      const session = service.extract(cardId);
      res.status(200).json({ cardId: session.cardId, contact: session.contact });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
