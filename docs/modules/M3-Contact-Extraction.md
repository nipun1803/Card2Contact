# M3 — Contact Extraction — Design

## Quick reference

- `POST /api/cards/{cardId}/extract`
- Depends on: merged raw text for `cardId` from M2 · Provides: draft contact object for `cardId` → M4

## 1. Purpose & scope

Parses raw OCR text into structured contact fields for the user to review.
Does NOT: decide or lock in a specific extraction technique/model (treated as a black-box contract), and does NOT guess a field that isn't present on the card.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. The extracted draft contact object is held transiently and returned to the client — it is never persisted to a database. The only durable write in the whole pipeline happens later, in M5, to the user's Google Sheet.

## 4. Business rules

- Extracted fields: Name, Designation, Phone[], Email, Company, Address[], Note, Category.
- A card may have more than one phone number and more than one address; both are captured as lists, not single values.
- A field not found on the card is left blank rather than guessed.

## 5. Endpoints

`POST /api/cards/{cardId}/extract`

- Purpose: run extraction over the raw text held for `cardId` and return a structured draft contact object.
- Request: none beyond `cardId` (path param).
- Response (`200`):
  ```json
  {
    "cardId": "3f1b...c9",
    "contact": {
      "name": "Jane Doe",
      "designation": "Branch Head",
      "phones": ["+1 555-123-4567"],
      "email": "jane@acme.com",
      "company": "Acme Inc",
      "addresses": ["1 Mayfair Road, Springfield"],
      "note": "",
      "category": ""
    }
  }
  ```
- No permission gate. Single extraction call per card; no repeated/N+1 calls.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |
| 409 | `PipelineOrderError` | `/extract` called before `/recognize` (no raw text held for `cardId` yet) |

## 6. Inter-module contracts

- Depends on: merged raw text for `cardId` from M2.
- Provides: structured draft contact object for `cardId`, consumed by M4 (Contact Review).

## Out of Scope

- The specific extraction technique or model used.

## Implementation Notes

- Since the doc explicitly leaves the extraction technique as an unlocked, black-box decision (§1), a regex/line-heuristic parser (`parseContactFromText` in `backend/src/modules/contact-extraction/contact-extraction.service.ts`) was written as a placeholder so the endpoint returns real data. It is intentionally isolated so it can be swapped for an AI/NLP-based extractor later without touching the service/router contract.
- **Markdown stripping**: M2's OCR output should already be plain text, but M3 doesn't assume upstream always did its job — `rawText` is run through the same Markdown-stripping pass (image refs dropped, links/bold/italic/headings unwrapped to plain text) before any line-based heuristic runs, and residual noise lines (bare URLs, rule/table-border artifacts, symbol-only lines) are filtered out entirely. This prevents artifacts like `![img-0.jpeg](img-0.jpeg)` or `**Infinity**` from ever landing in a structured field.
- Concretely, the heuristics are:
  - **name** = the first remaining line that reads like a person's name (1-5 words, letters/spaces/typical name punctuation only, not matching a designation or company keyword).
  - **designation** = the first remaining line containing a common job-title keyword (e.g. `Manager`, `Director`, `Head`, `CEO`, `Founder`) — checked before company so a title line is never mistaken for the company name.
  - **company** = every remaining text line (after name/designation/email/phone/address are removed), joined with a space — this deliberately captures multi-line company names/wordmarks (e.g. a brand name on one line and its category tagline on the next, like "Infinity" + "Flower Boutique") rather than picking only the first line and silently dropping the rest.
  - **phone** = regex-matched candidates, parsed and formatted via `libphonenumber-js` for correct country-aware grouping (e.g. `+919187654321` → `+91 91876 54321`) and deduplicated by canonical E.164 value rather than by display string. A bare/non-`+`-prefixed candidate is not parsed against a guessed region — it's passed through with punctuation normalized to spaces.
  - **email/address** are picked up by regex scans over the remaining lines, as before.
- Known limitation: the company heuristic still matches on a single line, so a company name that legitimately wraps across two OCR lines is only partially captured — unchanged from the original placeholder scope.
- This heuristic is NOT a documented business rule — only the doc's actual rules (arrays for phones/addresses, blank-if-not-found) are enforced as invariants.
- Implemented in `backend/src/modules/contact-extraction/`. Phone formatting depends on the `libphonenumber-js` package.
