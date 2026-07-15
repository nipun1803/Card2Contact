import { describe, expect, it } from "vitest";
import { M4Service } from "../../src/modules/contact-review/contact-review.service";
import { PipelineOrderError, ValidationError } from "../../src/shared/http/pipeline-errors";
import { CardNotFoundError } from "../../src/shared/store/card-session-store";
import { makeCardStore } from "../mocks/stores";
import { makeCardSession, makeContact } from "../fixtures/contacts";

/**
 * M4 — Contact Review. Rules (docs/modules/M4 §4): Name is the only required
 * field; edits merge shallowly (arrays replaced wholesale); confirm is blocked
 * only when Name is empty (after trim). Both ops require M3 to have run.
 */
describe("M4Service.editContact", () => {
  it("shallow-merges edits onto the existing contact", () => {
    const session = makeCardSession({ cardId: "c1", contact: makeContact({ name: "Old" }) });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);

    const updated = svc.editContact("c1", { name: "New", category: "Client" });

    expect(updated.contact?.name).toBe("New");
    expect(updated.contact?.category).toBe("Client");
    // Untouched field preserved.
    expect(updated.contact?.email).toBe(makeContact().email);
  });

  it("replaces the phones array wholesale, not per-item", () => {
    const session = makeCardSession({
      cardId: "c2",
      contact: makeContact({ phones: ["a", "b", "c"] }),
    });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);

    const updated = svc.editContact("c2", { phones: ["only"] });

    expect(updated.contact?.phones).toEqual(["only"]);
  });

  it("throws PipelineOrderError when M3 has not produced a contact", () => {
    const session = makeCardSession({ cardId: "c3", contact: null });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);
    expect(() => svc.editContact("c3", { name: "x" })).toThrow(PipelineOrderError);
  });
});

describe("M4Service.confirmContact", () => {
  it("marks the contact confirmed when Name is non-empty", () => {
    const session = makeCardSession({ cardId: "c1", contact: makeContact({ name: "Ada" }) });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);

    const updated = svc.confirmContact("c1");

    expect(updated.confirmed).toBe(true);
  });

  it("rejects confirmation when Name is empty", () => {
    const session = makeCardSession({ cardId: "c2", contact: makeContact({ name: "" }) });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);
    expect(() => svc.confirmContact("c2")).toThrow(ValidationError);
  });

  it("rejects confirmation when Name is whitespace-only", () => {
    const session = makeCardSession({ cardId: "c3", contact: makeContact({ name: "   " }) });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);
    expect(() => svc.confirmContact("c3")).toThrow(/Name is required/);
  });

  it("throws PipelineOrderError when there is no contact yet", () => {
    const session = makeCardSession({ cardId: "c4", contact: null });
    const store = makeCardStore([session]);
    const svc = new M4Service(store);
    expect(() => svc.confirmContact("c4")).toThrow(PipelineOrderError);
  });

  it("throws CardNotFoundError for an unknown card", () => {
    const svc = new M4Service(makeCardStore());
    expect(() => svc.confirmContact("ghost")).toThrow(CardNotFoundError);
  });
});
