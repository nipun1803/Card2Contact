# M1 — Image Acquisition — Design

## Quick reference

- `POST /api/cards`
- Depends on: nothing (pipeline entry point) · Provides: image reference(s) for `cardId` → M2

## 1. Purpose & scope

Captures or uploads the business card image(s) that start the pipeline, and records whether the card is single- or double-sided.
Does NOT: store images long-term, edit/crop images, or enforce upload quotas (now or future — quotas are out of MMVP scope).

## 2. Audience & permissions

Single implicit user, no roles or permission keys — MMVP has no auth/user management.

## 3. Entities (data model)

N/A. Images are held transiently for the duration of the submission (in-memory/session) and are not persisted to a database.

## 4. Business rules

- User selects single-sided or double-sided mode before/at capture.
- If double-sided, both front and back images are required before the card can be submitted.
- A card cannot be submitted without at least one image.
- `mode` must be exactly `"single"` or `"double"` — any other value is rejected.
- Each image file is capped at 10MB (enforced by `multer`); an oversized file is rejected rather than resized/compressed.

## 5. Endpoints

`POST /api/cards`

- Purpose: submit a new card for processing.
- Request: `multipart/form-data` — `mode` (`single` | `double`), `frontImage` (file), `backImage` (file, required if `mode=double`), each file ≤10MB.
- Response (`201`): `{ "cardId": "3f1b...c9", "mode": "single" }`
- No permission gate (single implicit user). No persisted-data query — request is held in-session only.

| Status | Error | Trigger |
|---|---|---|
| 400 | `ValidationError` | `mode` is missing or not `"single"`/`"double"` |
| 400 | `ValidationError` | `frontImage` missing |
| 400 | `ValidationError` | `mode=double` but `backImage` missing |
| 400 | `ValidationError` | a file exceeds the 10MB cap (`multer` `LIMIT_FILE_SIZE`) |

## 6. Inter-module contracts

- Provides: image reference(s) for `cardId`, consumed by M2 (Text Recognition).
- Depends on: nothing upstream (pipeline entry point).

## Out of Scope

- Image storage/retention policy.
- Image editing or cropping tools.
- Upload limits tied to user accounts or quotas.

## Implementation Notes

- `cardId` is a v4 UUID (`crypto.randomUUID()`), generated when the session is created.
- Images are parsed via `multer` memory storage (never written to disk) and held as raw `Buffer`s on the in-memory `CardSession` record — see `backend/src/shared/store/card-session-store.ts`.
- The 10MB cap above is enforced at the app layer (`multer` `fileSize` limit) and is separate from the nginx reverse-proxy body-size limit — see the nginx 413 issue in the repo's known-bugs notes; the two limits are independent and currently inconsistent (nginx's default is smaller).
- Frontend image source (per side): file upload (with `capture="environment"` so mobile opens the camera) OR live camera via `getUserMedia` → capture to canvas → `File` (`frontend/src/components/CameraCapture.tsx`). If the camera is denied/unavailable, the UI auto-falls back to upload. `getUserMedia` requires a secure context (https or localhost); over plain-HTTP non-localhost the camera path is unavailable and only upload works.
- Implemented in `backend/src/modules/image-acquisition/`.
