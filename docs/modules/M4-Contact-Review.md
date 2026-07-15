# M4 — Contact Review — Design

## Quick reference

- `PATCH /api/cards/{cardId}/contact`
- `POST /api/cards/{cardId}/confirm`
- Depends on: draft `Contact` for `cardId` from M3 · Provides: confirmed `Contact` for `cardId` → M5

## 1. Purpose & scope

Lets the user review, edit, and confirm the draft `Contact` before it's saved to Google Sheets.
Does NOT: deduplicate/merge with existing contacts, or support reviewing multiple cards in a single batch.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. The edited `Contact` is held transiently on the `CardSession` and is not persisted to a database.

## 4. Business rules

- Name is the only required field; Designation, Phone[], Email, Company, Address[], Note, and Category are all optional.
- User can add or remove individual phone numbers and addresses.
- Confirmation (and therefore save) is blocked only when Name is empty.

## 5. Endpoints

`PATCH /api/cards/{cardId}/contact`

- Purpose: apply user edits to the draft `Contact` fields for `cardId`.
- Request: partial `Contact` (any subset of Name, Designation, Phone[], Email, Company, Address[], Note, Category), e.g. `{ "phones": ["+1 555-123-4567", "+1 555-987-6543"] }`
- Response (`200`): `{ "cardId": "3f1b...c9", "contact": { "name": "Jane Doe", "designation": "Branch Head", "phones": ["+1 555-123-4567", "+1 555-987-6543"], "email": "jane@acme.com", "company": "Acme Inc", "addresses": [], "note": "", "category": "" } }` — the full merged `Contact`.
- Precondition: `contact !== null` on the `CardSession`. Postcondition: `contact` replaced with the merged object; `confirmed`/`saved` unchanged.
- Legal any time after `contact !== null` — including after `confirmed`/`saved` are already true. A post-save edit does not reset either flag, so it can silently diverge from the row already written to Sheets.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |
| 409 | `PipelineOrderError` | PATCH called before `/extract` (no draft `Contact` held for `cardId` yet) |

`POST /api/cards/{cardId}/confirm`

- Purpose: validate the current `Contact` and mark it ready for save.
- Request: none beyond `cardId` (path param).
- Response (`200`): `{ "cardId": "3f1b...c9", "confirmed": true, "contact": { ... } }`
- Precondition: `contact !== null` on the `CardSession`. Postcondition: `confirmed: true`; `contact` unchanged.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |
| 409 | `PipelineOrderError` | `/confirm` called before `/extract` (no draft `Contact` held for `cardId` yet) |
| 400 | `ValidationError` | `contact.name` is empty/whitespace-only |

Neither endpoint has a permission gate or repeated/N+1 calls.

## 6. Inter-module contracts

- Depends on: draft `Contact` for `cardId` from M3.
- Provides: confirmed `Contact` for `cardId`, consumed by M5 (Google Sheets Integration).

## Out of Scope

- Deduplication or merging with existing contacts.
- Reviewing multiple cards in a single batch.

## Implementation Notes

- PATCH is a shallow top-level merge (`{ ...existingContact, ...edits }`). A field present in the request replaces the stored value entirely — `phones[]`/`addresses[]` are whole-array replacements, not per-item append. There is no separate add/remove endpoint; the client sends the full desired array.
- `designation` required no M4-specific code changes: `ContactEdits = Partial<Contact>` and the shallow merge both operate generically over whatever `Contact` defines. Confirm validation only checks `name`.
- Frontend flow: confirm calls `PATCH .../contact` with the edited draft, then `POST .../confirm`, then M5 save, so the saved row reflects the user's edits.
- No I/O, no retries — pure in-process merge/validation.
- Implemented in `backend/src/modules/contact-review/`.
