import { Router, RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { ImageAcquisitionService } from "./image-acquisition.service";
import { CardSessionStore } from "../../shared/store/card-session-store";
import { ValidationError } from "../../shared/http/pipeline-errors";

// Largest single image we accept. Client-side downscaling keeps real uploads
// well under this; the cap is a backstop against unbounded in-memory buffers.
// Kept in sync with nginx's `client_max_body_size` (the edge cap).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// Buffers only — images are held in-memory for the session, never written to disk (M1 §3).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
});

/**
 * Wrap multer's middleware so a too-large upload surfaces as a domain
 * ValidationError (→ 400) instead of a raw MulterError (→ 500). Any other error
 * (including non-multer) is passed through unchanged.
 */
function handleUploadErrors(mw: RequestHandler): RequestHandler {
  return (req, res, next) =>
    mw(req, res, (err: unknown) => {
      if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
        next(new ValidationError("Image is too large (max 10MB)"));
        return;
      }
      next(err);
    });
}

export function createM1Router(store: CardSessionStore, uploadLimiter: RequestHandler): Router {
  const service = new ImageAcquisitionService(store);
  const router = Router();

  // POST /api/cards — docs/modules/M1-Image-Acquisition.md §5
  router.post(
    "/cards",
    // Before multer, deliberately: a rate-limited request should be rejected
    // without first buffering up to 10MB of image into memory.
    uploadLimiter,
    handleUploadErrors(
      upload.fields([
        { name: "frontImage", maxCount: 1 },
        { name: "backImage", maxCount: 1 },
      ]),
    ),
    (req, res, next) => {
      try {
        const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const mode = req.body.mode;
        const frontImage = files?.frontImage?.[0]?.buffer;
        const backImage = files?.backImage?.[0]?.buffer;

        const session = service.submitCard(mode, frontImage, backImage);
        res.status(201).json({ cardId: session.cardId, mode: session.mode });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
