# M2 — Text Recognition — Design

## Quick reference

- `POST /api/cards/{cardId}/recognize`
- Depends on: image(s) for `cardId` from M1 · Provides: merged raw text for `cardId` → M3

## 1. Purpose & scope

Converts the card image(s) held from M1 into raw text using OCR, merging front and back text when the card is double-sided.
Does NOT: train/tune OCR models, or handle languages beyond what the OCR provider supports natively.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. Raw OCR text is held transiently on the `CardSession` and is not persisted to a database.

## 4. Business rules

- Front and back images are recognized independently.
- Their raw text outputs are merged into a single text block in front-then-back order before handoff to M3.

## 5. Endpoints

`POST /api/cards/{cardId}/recognize`

- Purpose: run OCR on the image(s) held for `cardId` and return merged raw text.
- Request: none beyond `cardId` (path param).
- Response (`200`): `{ "cardId": "3f1b...c9", "rawText": "Jane Doe\nAcme Inc\njane@acme.com" }`
- Precondition: `CardSession` exists for `cardId` (from M1).
- Postcondition: `rawText` set on the session; all other fields unchanged.
- No permission gate. One OCR call per image, no repeated/N+1 calls.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |

## 6. Inter-module contracts

- Depends on: image(s) for `cardId` from M1.
- Provides: merged raw text for `cardId`, consumed by M3 (Contact Extraction).

## Out of Scope

- OCR model training or tuning.
- Language handling beyond what the OCR service provides natively.

## Implementation Notes

### Algorithm

OCR provider: `@mistralai/mistralai` SDK, `client.ocr.process({ model: "mistral-ocr-latest", document: { type: "image_url", imageUrl } })`. Images are sent as inline base64 `data:image/png;...` URIs regardless of real upload content-type (no public URL exists for in-memory buffers).

Response pages' `markdown` fields are Markdown, not plain text (Mistral renders detected images/logos as `![alt](src)`, prominent text as `**bold**`/`*italic*`/headings). Each page is passed through `stripMarkdown` before pages are joined:

| Step | Pattern | Result |
|---|---|---|
| 1 | `![alt](src)` | dropped entirely |
| 2 | `[text](url)` | kept as `text` |
| 3 | `**text**` | unwrapped to `text` |
| 4 | `*text*` | unwrapped to `text` |
| 5 | ATX headings (`#`–`######`) | leading marker stripped |

Front+back merge: each image OCR'd independently; each image's stripped pages joined with `"\n"` and `.trim()`-ed; front and back results then joined with a single `"\n"` (back omitted entirely when absent/single-sided).

If a response has no `pages` (or an empty array), the result degrades to `""` rather than throwing.

### Error handling

The OCR client is lazily constructed on the first `/recognize` call, so `MISTRAL_API_KEY` isn't required at boot. A missing key throws a plain `Error` — not a domain error class — so it surfaces as a generic 500, not a clean 4xx. No retry on OCR failure; a provider error propagates as a 500 and nothing is written to the session.

### Performance

One external OCR call per image (one or two per card, awaited sequentially) — the dominant latency source in the pipeline.

- The provider call is isolated behind an `OcrClient` interface (`text-recognition.client.ts`) so the provider can be swapped without touching business logic. The SDK's `{ pages: [{ markdown }] }` response shape is flagged in the code as an assumption to verify against future SDK versions.
- Credential: `MISTRAL_API_KEY` environment variable. Never hardcoded.
- Implemented in `backend/src/modules/text-recognition/`.
