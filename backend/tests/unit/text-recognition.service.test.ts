import { describe, expect, it, vi } from "vitest";
import { M2Service } from "../../src/modules/text-recognition/text-recognition.service";
import { CardNotFoundError } from "../../src/shared/store/card-session-store";
import { makeCardStore, makeOcrClient } from "../mocks/stores";
import { makeCardSession } from "../fixtures/contacts";

/**
 * M2 — Text Recognition. Rules (docs/modules/M2 §4-5): front and back are
 * recognized independently; outputs merge front-then-back; one OCR call per
 * image (no N+1). Back is only recognized in double mode when present.
 */
describe("M2Service.recognize", () => {
  it("runs OCR on the front image and stores the raw text (single mode)", async () => {
    const session = makeCardSession({ cardId: "c1", mode: "single" });
    const store = makeCardStore([session]);
    const ocr = makeOcrClient("FRONT TEXT");
    const svc = new M2Service(store, ocr);

    const updated = await svc.recognize("c1");

    expect(ocr.recognize).toHaveBeenCalledOnce();
    expect(updated.rawText).toBe("FRONT TEXT");
  });

  it("merges front then back with a newline in double mode", async () => {
    const session = makeCardSession({
      cardId: "c2",
      mode: "double",
      backImage: Buffer.from("back"),
    });
    const store = makeCardStore([session]);
    const ocr = makeOcrClient((img) => (img.toString() === "back" ? "BACK" : "FRONT"));
    const svc = new M2Service(store, ocr);

    const updated = await svc.recognize("c2");

    expect(ocr.recognize).toHaveBeenCalledTimes(2);
    expect(updated.rawText).toBe("FRONT\nBACK");
  });

  it("does not call OCR on the back when double mode has no back image", async () => {
    const session = makeCardSession({ cardId: "c3", mode: "double", backImage: null });
    const store = makeCardStore([session]);
    const ocr = makeOcrClient("FRONT");
    const svc = new M2Service(store, ocr);

    const updated = await svc.recognize("c3");

    expect(ocr.recognize).toHaveBeenCalledOnce();
    expect(updated.rawText).toBe("FRONT");
  });

  it("propagates CardNotFoundError for an unknown card", async () => {
    const svc = new M2Service(makeCardStore(), makeOcrClient());
    await expect(svc.recognize("ghost")).rejects.toBeInstanceOf(CardNotFoundError);
  });

  it("propagates a provider error from the OCR client", async () => {
    const session = makeCardSession({ cardId: "c4" });
    const store = makeCardStore([session]);
    const ocr = { recognize: vi.fn().mockRejectedValue(new Error("mistral 500")) };
    const svc = new M2Service(store, ocr);
    await expect(svc.recognize("c4")).rejects.toThrow("mistral 500");
  });
});
