/**
 * The MCP endpoint's numeric ceilings (#773, #776 item 1).
 *
 * The body READER that enforces the last of them moved to
 * `#/lib/request-body-limits` when `/api/pathways/ingest` became its second
 * caller (#800). Nothing about it was MCP-specific; these numbers are.
 *
 * **Why they live here and not beside their callers.** Each of these
 * numbers was first written in the module that reads it — `MAX_BODY_BYTES` in
 * `handle-request.ts`, `MAX_RESULTS` in `find-people.ts`,
 * `MAX_GUEST_BOOK_ENTRIES` in `record-guest-book.ts` — and every one of those
 * modules imports `#/db` at load. `CODING_STANDARDS.md` ("Test coverage") calls
 * that shape unassertable, and it is literal here: a vitest file cannot import
 * `record-guest-book.ts` without a database, so the entry cap could have been
 * raised to 5,000,000 with the whole suite green. The repo already keeps ten
 * `src/lib/*-limits.ts` modules for exactly this reason; this is the eleventh.
 *
 * Nothing here imports `#/db`, `pg`, or any server module, so
 * `mcp-limits.test.ts` asserts the values directly. That test is the point of
 * the move, not a bonus.
 */

/**
 * How many lines of the paper guest book one `record_guest_book` call may carry.
 *
 * The book is transcribed one page at a time and a page holds a dozen or so
 * names; 100 is far more than one page and still small enough that the plan,
 * the hash and the locked section stay cheap.
 */
export const MAX_GUEST_BOOK_ENTRIES = 100;

/**
 * How many assignments one `assign_roles` call may carry (#809).
 *
 * A meeting's agenda is a few dozen slots at the very most, so 100 is "the
 * whole agenda and then some" — big enough that no real call is refused, small
 * enough that the batch's transaction stays short while it holds a `FOR UPDATE`
 * row lock on every slot it names.
 */
export const MAX_ROLE_ASSIGNMENTS = 100;

/**
 * How many people one `find_people` call returns.
 *
 * A club's roster plus its live prospect list. The tool reports `truncated`
 * rather than silently returning a prefix, because a caller that believes it
 * has everyone will conclude a name is absent.
 */
export const MAX_FIND_PEOPLE_RESULTS = 200;

/**
 * 1 MB — the largest request body `/api/mcp` will read. A 100-entry guest-book
 * page is a few KB.
 *
 * NOT the same number as `/api/pathways/ingest`'s ceiling, which is 5 MB
 * (`MAX_INGEST_BODY_BYTES`). This comment claimed they were identical from the
 * day it was written and they never were; the two endpoints carry different
 * payloads and each owns its own number.
 *
 * Enforced by `readBodyWithinCap` (`#/lib/request-body-limits`) WHILE the body
 * streams in, not after, so the ceiling bounds memory rather than merely
 * reporting on it.
 */
export const MAX_MCP_BODY_BYTES = 1_000_000;
