/**
 * `/api/pathways/ingest`'s request-body ceiling (#800).
 *
 * Its own constant, deliberately not shared with `/api/mcp`'s
 * `MAX_MCP_BODY_BYTES`: the two endpoints carry different payloads and the
 * numbers are different. A single "body cap" that both imported would make
 * every future tuning of one a change to the other.
 *
 * In `lib/` rather than beside the handler because the handler's module reaches
 * `#/db`, and a constant behind a `#/db` import cannot be asserted by a unit
 * test at all — it could be raised to 5,000,000,000 with the whole suite green.
 * `CODING_STANDARDS.md` ("Test coverage") records the four times that shape has
 * cost this repo something.
 */

/**
 * ~5 MB — the largest request body `/api/pathways/ingest` will read.
 *
 * A full 30-member club sync with details is under 1 MB, so this only trips on
 * hostile or garbage input. Enforced by `readBodyWithinCap` WHILE the body
 * streams in (and before the `gup_` token is looked at, because the body is
 * read before anything authenticates), so the number bounds memory rather than
 * labelling a 413.
 */
export const MAX_INGEST_BODY_BYTES = 5_000_000;
