# M1 — Image Acquisition — Design

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

## 5. Endpoints
`POST /api/cards`
- Purpose: submit a new card for processing.
- Request: multipart form — `mode` (`single` | `double`), `frontImage` (file), `backImage` (file, required if `mode=double`).
- Response: `{ cardId, mode }`.
- No permission gate (single implicit user). No persisted-data query — request is held in-session only.

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
- Frontend image source (per side): file upload (with `capture="environment"` so mobile opens the camera) OR live camera via `getUserMedia` → capture to canvas → `File` (`frontend/src/components/CameraCapture.tsx`). If the camera is denied/unavailable, the UI auto-falls back to upload. `getUserMedia` requires a secure context (https or localhost); over plain-HTTP non-localhost the camera path is unavailable and only upload works.
- Implemented in `backend/src/modules/image-acquisition/`.
