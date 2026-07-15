import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardSession } from "../../shared/types/card-session";
import { Contact, ContactEdits } from "../../shared/types/contact";
import { PipelineOrderError, ValidationError } from "../../shared/http/pipeline-errors";

/**
 * M4 — Contact Review business rules (docs/modules/M4-Contact-Review.md §4):
 * - Name is the only required field; phones[], email, company, addresses[],
 *   note, and category are all optional.
 * - Adding/removing individual phone numbers and addresses is handled by the
 *   client sending the full desired array in the PATCH body — the edited
 *   arrays replace the existing ones wholesale.
 * - Confirmation (and therefore save) is blocked only when Name is empty.
 *
 * Both operations act on the draft contact produced by M3. If M3 has not run
 * yet (session.contact is null), the pipeline is out of order.
 */
export class M4Service {
  constructor(private readonly store: CardSessionStore) {}

  /**
   * Apply a partial edit to the draft contact for `cardId`. The edits are
   * merged shallowly onto the existing contact: fields present in `edits`
   * overwrite existing values (including whole-array replacement for
   * phones/addresses), fields absent from `edits` are left unchanged.
   */
  editContact(cardId: string, edits: ContactEdits): CardSession {
    const session = this.store.get(cardId);
    if (session.contact === null) {
      throw new PipelineOrderError("contact extraction (M3 /extract)");
    }

    const merged: Contact = { ...session.contact, ...edits };
    return this.store.update(cardId, { contact: merged });
  }

  /**
   * Validate the current contact for `cardId` and mark it confirmed. Blocked
   * only when Name is empty (trimmed).
   */
  confirmContact(cardId: string): CardSession {
    const session = this.store.get(cardId);
    if (session.contact === null) {
      throw new PipelineOrderError("contact extraction (M3 /extract)");
    }

    if (session.contact.name.trim() === "") {
      throw new ValidationError("Name is required to confirm the contact");
    }

    return this.store.update(cardId, { confirmed: true });
  }
}
