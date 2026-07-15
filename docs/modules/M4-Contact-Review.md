# M4 — Contact Review — Design

## Quick reference

- `PATCH /api/cards/{cardId}/contact`
- `POST /api/cards/{cardId}/confirm`
- Depends on: draft contact object for `cardId` from M3 · Provides: confirmed contact object for `cardId` → M5

## 1. Purpose & scope

Lets the user review, edit, and confirm the draft contact object before it's saved to Google Sheets.
Does NOT: deduplicate/merge with existing contacts, or support reviewing multiple cards in a single batch.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. The edited contact object is held transiently for the duration of the session and is not persisted to a database.

## 4. Business rules

- Name is the only required field; Designation, Phone[], Email, Company, Address[], Note, and Category are all optional.
- User can add or remove individual phone numbers and addresses.
- Confirmation (and therefore save) is blocked only when Name is empty.

## 5. Endpoints

`PATCH /api/cards/{cardId}/contact`

- Purpose: apply user edits to the draft contact fields for `cardId`.
- Request: partial `contact` object (any subset of Name, Designation, Phone[], Email, Company, Address[], Note, Category), e.g. `{ "phones": ["+1 555-123-4567", "+1 555-987-6543"] }`
- Response (`200`): `{ "cardId": "3f1b...c9", "contact": { "name": "Jane Doe", "designation": "Branch Head", "phones": ["+1 555-123-4567", "+1 555-987-6543"], "email": "jane@acme.com", "company": "Acme Inc", "addresses": [], "note": "", "category": "" } }` — the full merged contact.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |
| 409 | `PipelineOrderError` | PATCH called before `/extract` (no draft contact held for `cardId` yet) |

`POST /api/cards/{cardId}/confirm`

- Purpose: validate the current contact object and mark it ready for save.
- Request: none beyond `cardId` (path param).
- Response (`200`): `{ "cardId": "3f1b...c9", "confirmed": true, "contact": { ... } }`

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |
| 409 | `PipelineOrderError` | `/confirm` called before `/extract` (no draft contact held for `cardId` yet) |
| 400 | `ValidationError` | `contact.name` is empty/whitespace-only |

Neither endpoint has a permission gate. Both operate on the single in-session contact object for `cardId`; no repeated/N+1 calls.

## 6. Inter-module contracts

- Depends on: draft contact object for `cardId` from M3.
- Provides: confirmed contact object for `cardId`, consumed by M5 (Google Sheets Integration).

## Out of Scope

- Deduplication or merging with existing contacts.
- Reviewing multiple cards in a single batch.

## Implementation Notes

- PATCH merge semantics: a shallow top-level merge (`{ ...existingContact, ...edits }`). Any field present in the request body replaces the stored value entirely — for `phones[]`/`addresses[]` this means whole-array replacement, not per-item append. Add/remove of individual phone numbers or addresses is therefore achieved by the client sending the full desired array; there is no separate add/remove endpoint, matching what §5 documents.
- Frontend flow: on confirm, the frontend calls `PATCH .../contact` with the edited draft, then `POST .../confirm`, then M5 save — so the saved row reflects the user's edits. (Previously the PATCH was skipped and edits were dropped.)
- Implemented in `backend/src/modules/contact-review/`.
