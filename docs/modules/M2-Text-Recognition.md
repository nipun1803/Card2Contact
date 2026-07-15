# M2 — Text Recognition — Design

## Quick reference

- `POST /api/cards/{cardId}/recognize`
- Depends on: image reference(s) for `cardId` from M1 · Provides: merged raw text for `cardId` → M3

## 1. Purpose & scope

Converts the card image(s) held from M1 into raw text using OCR, merging front and back text when the card is double-sided.
Does NOT: train/tune OCR models, or handle languages beyond what the OCR provider supports natively.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. Raw OCR text is held transiently for the duration of the submission and is not persisted to a database.

## 4. Business rules

- Front and back images are recognized independently.
- Their raw text outputs are merged into a single text block in front-then-back order before handoff to M3.

## 5. Endpoints

`POST /api/cards/{cardId}/recognize`

- Purpose: run OCR on the image(s) held for `cardId` and return merged raw text.
- Request: none beyond `cardId` (path param).
- Response (`200`): `{ "cardId": "3f1b...c9", "rawText": "Jane Doe\nAcme Inc\njane@acme.com" }`
- No permission gate. Single call to the Mistral OCR provider per image; no repeated/N+1 calls.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |

## 6. Inter-module contracts

- Depends on: image reference(s) for `cardId` from M1.
- Provides: merged raw text for `cardId`, consumed by M3 (Contact Extraction).

## Out of Scope

- OCR model training or tuning.
- Language handling beyond what the OCR service provides natively.

## Implementation Notes

- OCR provider: `@mistralai/mistralai` SDK, `client.ocr.process({ model: "mistral-ocr-latest", document: { type: "image_url", imageUrl } })`. Images are sent as inline base64 `data:` URIs (no public URL exists for in-memory buffers). Response pages' `markdown` fields are Markdown, not plain text (Mistral renders detected images/logos as `![alt](src)` and stylized/prominent text as `**bold**`/`*italic*`/headings) — each page's `markdown` is passed through `stripMarkdown` (image refs dropped, link/bold/italic/heading syntax unwrapped to plain text) before pages are concatenated and `.trim()`-ed, so M3 always receives plain text.
- If the OCR response has no `pages` (or an empty array), the result degrades silently to `""` rather than throwing — a blank `rawText` is valid input to hand to M3, not an error condition.
- Credential: `MISTRAL_API_KEY` environment variable. Never hardcoded.
- The provider call is isolated behind an `OcrClient` interface in `backend/src/modules/text-recognition/text-recognition.client.ts` so the provider can be swapped without touching business logic.
- Implemented in `backend/src/modules/text-recognition/`.
