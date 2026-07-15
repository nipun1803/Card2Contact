# M3 — Contact Extraction — Design

## 1. Purpose & scope

Parses raw OCR text into structured contact fields for the user to review.
Does NOT: decide or lock in a specific extraction technique/model (treated as a black-box contract), and does NOT guess a field that isn't present on the card.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. The extracted draft contact object is held transiently and returned to the client — it is never persisted to a database. The only durable write in the whole pipeline happens later, in M5, to the user's Google Sheet.

## 4. Business rules

- Extracted fields: Name, Phone[], Email, Company, Address[], Note, Category.
- A card may have more than one phone number and more than one address; both are captured as lists, not single values.
- A field not found on the card is left blank rather than guessed.

## 5. Endpoints

`POST /api/cards/{cardId}/extract`

- Purpose: run extraction over the raw text held for `cardId` and return a structured draft contact object.
- Request: none beyond `cardId` (path param).
- Response: `{ cardId, contact: { name, phones: [], email, company, addresses: [], note, category } }`.
- No permission gate. Single extraction call per card; no repeated/N+1 calls.

## 6. Inter-module contracts

- Depends on: merged raw text for `cardId` from M2.
- Provides: structured draft contact object for `cardId`, consumed by M4 (Contact Review).

## Out of Scope

- The specific extraction technique or model used.

## Implementation Notes

- Since the doc explicitly leaves the extraction technique as an unlocked, black-box decision (§1), a regex/line-heuristic parser (`parseContactFromText` in `backend/src/modules/contact-extraction/contact-extraction.service.ts`) was written as a placeholder so the endpoint returns real data. It is intentionally isolated so it can be swapped for an AI/NLP-based extractor later without touching the service/router contract.
- This heuristic is NOT a documented business rule — only the doc's actual rules (arrays for phones/addresses, blank-if-not-found) are enforced as invariants.
- Implemented in `backend/src/modules/contact-extraction/`.
