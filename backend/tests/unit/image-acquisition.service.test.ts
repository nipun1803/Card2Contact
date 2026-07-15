import { describe, expect, it } from "vitest";
import { ImageAcquisitionService } from "../../src/modules/image-acquisition/image-acquisition.service";
import { ValidationError } from "../../src/shared/http/pipeline-errors";
import { makeCardStore } from "../mocks/stores";

/**
 * M1 — Image Acquisition. Business rules (docs/modules/M1 §4): mode must be
 * single|double; at least one image required; double requires both.
 */
describe("ImageAcquisitionService.submitCard", () => {
  const front = Buffer.from("front");
  const back = Buffer.from("back");

  it("creates a single-mode card with only the front image", () => {
    const store = makeCardStore();
    const svc = new ImageAcquisitionService(store);

    const session = svc.submitCard("single", front, undefined);

    expect(session.mode).toBe("single");
    expect(session.frontImage).toEqual(front);
    expect(session.backImage).toBeNull();
    expect(store.create).toHaveBeenCalledOnce();
  });

  it("creates a double-mode card carrying both images", () => {
    const svc = new ImageAcquisitionService(makeCardStore());
    const session = svc.submitCard("double", front, back);
    expect(session.mode).toBe("double");
    expect(session.backImage).toEqual(back);
  });

  it("drops the back image in single mode even if one is supplied", () => {
    const svc = new ImageAcquisitionService(makeCardStore());
    const session = svc.submitCard("single", front, back);
    expect(session.backImage).toBeNull();
  });

  it("rejects an unknown mode", () => {
    const svc = new ImageAcquisitionService(makeCardStore());
    expect(() => svc.submitCard("triple" as never, front, undefined)).toThrow(ValidationError);
  });

  it("rejects a submission with no front image", () => {
    const svc = new ImageAcquisitionService(makeCardStore());
    expect(() => svc.submitCard("single", undefined, undefined)).toThrow(
      /without at least one image/,
    );
  });

  it("rejects double mode when the back image is missing", () => {
    const svc = new ImageAcquisitionService(makeCardStore());
    expect(() => svc.submitCard("double", front, undefined)).toThrow(
      /Both front and back/,
    );
  });
});
