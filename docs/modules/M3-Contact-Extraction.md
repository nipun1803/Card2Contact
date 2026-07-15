# M3 — Contact Extraction — Design

## Quick reference

- `POST /api/cards/{cardId}/extract`
- Depends on: merged raw text for `cardId` from M2 · Provides: draft `Contact` for `cardId` → M4

## 1. Purpose & scope

Parses raw OCR text into structured contact fields for the user to review.
Does NOT: decide or lock in a specific extraction technique/model (treated as a black-box contract), and does NOT guess a field that isn't present on the card.

## 2. Audience & permissions

Single implicit user, no roles or permission keys.

## 3. Entities (data model)

N/A. The extracted draft `Contact` is held transiently on the `CardSession` and returned to the client — never persisted to a database. The only durable write in the pipeline happens later, in M5, to the user's Google Sheet.

## 4. Business rules

- Extracted fields: Name, Designation, Phone[], Email, Company, Address[], Note, Category.
- A card may have more than one phone number and more than one address; both are captured as lists, not single values.
- A field not found on the card is left blank rather than guessed.

**Field constraints** (`Contact`, `backend/src/shared/types/contact.ts`) — every field is non-optional at the type level; "optional" above means "may be blank," not nullable:

| Field | Type | Default | Constraint |
|---|---|---|---|
| `name` | `string` | `""` | none enforced by M3; M4 requires non-blank to confirm |
| `designation` | `string` | `""` | single line, first job-title-keyword match |
| `phones` | `string[]` | `[]` | deduped by canonical E.164 value |
| `email` | `string` | `""` | first regex match only |
| `company` | `string` | `""` | may join multiple lines with a space |
| `addresses` | `string[]` | `[]` | deduped; each entry may join multiple lines with `", "` |
| `note` | `string` | `""` | never set by extraction |
| `category` | `string` | `""` | never set by extraction |

## 5. Endpoints

`POST /api/cards/{cardId}/extract`

- Purpose: run extraction over the raw text held for `cardId` and return a structured draft `Contact`.
- Request: none beyond `cardId` (path param).
- Response (`200`): `{ "cardId": "3f1b...c9", "contact": { "name": "Jane Doe", "designation": "Branch Head", "phones": ["+1 555-123-4567"], "email": "jane@acme.com", "company": "Acme Inc", "addresses": ["1 Mayfair Road, Springfield"], "note": "", "category": "" } }`
- Precondition: `rawText !== null` on the session (M2 `/recognize` has run).
- Postcondition: `contact` set on the session; all other fields unchanged.
- No permission gate. One extraction call per card, no repeated/N+1 calls.

| Status | Error | Trigger |
|---|---|---|
| 404 | `CardNotFoundError` | `cardId` unknown |
| 409 | `PipelineOrderError` | `/extract` called before `/recognize` (no raw text held for `cardId` yet) |

## 6. Inter-module contracts

- Depends on: merged raw text for `cardId` from M2.
- Provides: structured draft `Contact` for `cardId`, consumed by M4 (Contact Review).

## Out of Scope

- The specific extraction technique or model used.

## Implementation Notes

Since §1 explicitly leaves the extraction technique unlocked, a regex/line-heuristic parser (`parseContactFromText` in `backend/src/modules/contact-extraction/contact-extraction.service.ts`) was written as a placeholder, isolated so it can be swapped for an AI/NLP-based extractor without touching the service/router contract. This heuristic is NOT a documented business rule — only §4's actual rules are enforced as invariants.

### Algorithm

Each step narrows what the next step can see:

1. `stripMarkdown` (same transform as M2 — M3 doesn't assume M2 already ran).
2. Split into lines, drop noise lines (rule/table-border artifacts, bare URLs, symbol-only lines), keep blanks as address-group separators.
3. Email = first regex match over the whole text.
4. Phones = all regex matches over the whole text (line breaks excluded from the match class, so a phone can never swallow the next line's leading digit).
5. `textLines` = remaining lines minus the email line, mostly-digit lines, and address-like lines.
6. Name = first `textLines` entry matching a name shape, not a designation/company keyword.
7. Designation = first remaining entry matching a job-title keyword.
8. Company = every entry still left, joined with a space (captures multi-line company names/wordmarks).
9. Addresses = a separate pass over all lines (including blanks), grouping consecutive address-like lines into one entry each; a blank line is a hard boundary between two addresses.

| Field | Heuristic |
|---|---|
| Phone | Regex candidates parsed via `libphonenumber-js` for country-aware formatting (e.g. `+919187654321` → `+91 91876 54321`), deduped by canonical E.164. A bare (non-`+`) candidate isn't region-guessed — punctuation is just normalized to spaces. |
| Address | Address-like = leading/ordinal street number, trailing postal-code digit run, or an address keyword (Street, Floor, Tower, Sector, Suite, etc.) — any one signal qualifies. Mostly-digit lines are excluded first so a phone's digit run is never mistaken for a postal code. |

### Worked example

Input: `"Jane Doe\nBranch Head\nAcme Solutions\nFlower Boutique\n+91 91876 54321\njane@acme.com\n123 Main St"`

```json
{
  "name": "Jane Doe",
  "designation": "Branch Head",
  "phones": ["+91 91876 54321"],
  "email": "jane@acme.com",
  "company": "Acme Solutions Flower Boutique",
  "addresses": ["123 Main St"],
  "note": "",
  "category": ""
}
```

### Error handling / Performance

Pure in-process string/regex work — no I/O, no retries, nothing to roll back, no external calls or DB access.

Implemented in `backend/src/modules/contact-extraction/`. Phone formatting depends on the `libphonenumber-js` package.
