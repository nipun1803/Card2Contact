import { Mistral } from "@mistralai/mistralai";

/**
 * Isolated Mistral OCR integration for M2. This is the ONLY place the
 * `@mistralai/mistralai` SDK is referenced — the rest of the module (and the
 * shared package) depend on the small `OcrClient` interface below, so the
 * provider is swappable without touching business logic.
 */
export interface OcrClient {
  /** Run OCR on a single image buffer and return the recognized text. */
  recognize(image: Buffer): Promise<string>;
}

/**
 * Mistral-backed OCR client.
 *
 * ASSUMPTION (verify against installed @mistralai/mistralai@^1.3.5): the SDK
 * exposes `client.ocr.process({ model, document })` where `document` is a
 * `{ type: "image_url", imageUrl: <data URI> }` object, and the response is
 * `{ pages: [{ markdown: string }, ...] }`. We send the image inline as a
 * base64 `data:` URI (no public URL is available for in-memory buffers) and
 * concatenate every page's markdown into one text block. If the real signature
 * differs, only this file needs to change.
 */
export class MistralOcrClient implements OcrClient {
  private readonly client: Mistral;
  private readonly model: string;

  constructor(apiKey: string, model = "mistral-ocr-latest") {
    this.client = new Mistral({ apiKey });
    this.model = model;
  }

  async recognize(image: Buffer): Promise<string> {
    const dataUri = `data:image/png;base64,${image.toString("base64")}`;

    // Single call per image — no per-page or retry fan-out (M2 §5: no N+1).
    const response = await this.client.ocr.process({
      model: this.model,
      document: {
        type: "image_url",
        imageUrl: dataUri,
      },
    });

    return (response.pages ?? [])
      .map((page) => page.markdown ?? "")
      .join("\n")
      .trim();
  }
}

/**
 * Builds the default provider-backed client from the environment. Kept as a
 * factory so the M2 router constructs the real Mistral client while tests can
 * inject a fake `OcrClient`.
 */
export function createMistralOcrClient(): OcrClient {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not set");
  }
  return new MistralOcrClient(apiKey);
}
