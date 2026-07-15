import { CardSessionStore } from "../../shared/store/card-session-store";
import { CardMode, CardSession } from "../../shared/types/card-session";
import { ValidationError } from "../../shared/http/pipeline-errors";

/**
 * M1 — Image Acquisition business rules (docs/modules/M1-Image-Acquisition.md §4):
 * - mode must be single or double.
 * - double mode requires both front and back images.
 * - a card cannot be submitted without at least one image.
 */
export class ImageAcquisitionService {
  constructor(private readonly store: CardSessionStore) {}

  submitCard(mode: CardMode, frontImage: Buffer | undefined, backImage: Buffer | undefined): CardSession {
    if (mode !== "single" && mode !== "double") {
      throw new ValidationError('mode must be "single" or "double"');
    }
    if (!frontImage) {
      throw new ValidationError("A card cannot be submitted without at least one image");
    }
    if (mode === "double" && !backImage) {
      throw new ValidationError("Both front and back images are required for double-sided mode");
    }

    return this.store.create(mode, frontImage, mode === "double" ? backImage! : null);
  }
}
