import { Router } from "express";
import { M4Service } from "./contact-review.service";
import { CardSessionStore } from "../../shared/store/card-session-store";
import { ContactEdits } from "../../shared/types/contact";

export function createM4Router(store: CardSessionStore): Router {
  const service = new M4Service(store);
  const router = Router();

  // PATCH /api/cards/:cardId/contact — docs/modules/M4-Contact-Review.md §5
  router.patch("/cards/:cardId/contact", (req, res, next) => {
    try {
      const edits = req.body as ContactEdits;
      const session = service.editContact(req.params.cardId, edits);
      res.json({ cardId: session.cardId, contact: session.contact });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/cards/:cardId/confirm — docs/modules/M4-Contact-Review.md §5
  router.post("/cards/:cardId/confirm", (req, res, next) => {
    try {
      const session = service.confirmContact(req.params.cardId);
      res.json({ cardId: session.cardId, confirmed: session.confirmed, contact: session.contact });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
