import { MEETING_LIMITS } from "./meeting-limits";

/**
 * Render-side caps for the minutes PDF's program list (#522).
 *
 * The minutes PDF is gated — it needs a session and club membership, and
 * non-admins additionally need the minutes to be `completed` (admins bypass
 * that last one). So it is not the unauthenticated surface #519 closed. It
 * still renders synchronously in the single Node process (ADR-0007), so an
 * oversized value stalls every other request, and any club member can reach it.
 *
 * These bound the RENDER rather than the write, which is the half that matters
 * for rows already in the database: the speaker-detail write caps added in #522
 * cannot retroactively shorten a value stored before them, and this change
 * ships no backfill.
 *
 * Lives in `lib/` rather than beside the renderer so the NUMBERS are testable.
 * `minutes-pdf-logic.ts` imports `#/db` at module load, so importing it from a
 * unit test throws `DATABASE_URL is not set` — which meant that while these
 * caps lived there, nothing could assert their values and they could be raised
 * to 5,000,000 with the whole suite green. That is trap 5, and the first
 * version of #522 shipped it inside the change that cites trap 5.
 *
 * `speechTitle` is deliberately absent: the program row reuses
 * `SPEAKER_LIMITS.speechTitle` directly so the write cap and the render cap
 * cannot drift apart.
 *
 * `name` and `roleName` are capped at render but NOT on write, and that is
 * defence in depth rather than a hole being patched. The PUBLIC guest self-add
 * is already bounded (`guestBookSchema` caps a name at 120, an email at 200, a
 * phone at 40) and `members.ts` bounds a member name at 80. Every name write
 * that remains unbounded is admin-gated. Capping here anyway costs one call
 * each and covers what a write cap cannot: a row written before any cap, and a
 * future write path added without one.
 */
export const MINUTES_RENDER_CAPS = {
	/** A person's name, in the program, attendance and awards lists. */
	name: 120,
	/** A role label. Admin-authored, unbounded on write. */
	roleName: 120,
	/** The club's name, in the document title and the header. */
	club: 120,
	/**
	 * The meeting theme, and a Table Topics topic below it.
	 *
	 * Both now read the WRITE cap rather than declaring a number, so the two
	 * cannot drift — the same reason the program row reads
	 * `SPEAKER_LIMITS.speechTitle`. #525 bounded them on write; until then the
	 * render cap was the only thing stopping a no-session `theme` from reaching
	 * the renderer, and it still covers rows written before that landed.
	 */
	theme: MEETING_LIMITS.theme,
	/** Word of the Day. Already write-capped by #519; this covers older rows. */
	word: 120,
	topic: MEETING_LIMITS.topic,

	/**
	 * ROW-COUNT caps. The per-row string caps above bound each item; these bound
	 * how many items there are, which is the other half and the one #522's first
	 * pass missed. react-pdf's cost is super-linear in row count even when every
	 * row is short, and the count is attacker-controlled with no session:
	 * `addSpeakerSlot` goes through the same `tmod-self-assert` path and inserts
	 * two `role_slots` per call with no ceiling.
	 *
	 * Measured through the same renderer with ordinary, well-capped row text:
	 *
	 *     40 rows →   112 ms      2,000 rows →  2,477 ms
	 *    200 rows →   102 ms      5,000 rows → 19,581 ms
	 *    500 rows →   285 ms
	 *
	 * Flat to ~500, then super-linear. The role sheets bound the same way
	 * (`RENDER_CAPS.speakerRows`).
	 *
	 * Sized against ASTRAL text, not ASCII, and that is why these are tens
	 * rather than hundreds. A length cap bounds code points, not cost, and cost
	 * per code point is not constant: at the SAME capped sizes, emoji rows cost
	 * about 13x ASCII rows, because each one needs font fallback and shaping.
	 *
	 *    200 rows x 440 ASCII chars  →   217 ms
	 *    200 rows x 200 emoji points → 2,778 ms
	 *
	 * A first pass at #522 used 200/100 here, and the all-axes-hostile fixture
	 * in `minutes-pdf-bounds.test.ts` still took 8.9 SECONDS with every string
	 * cap correctly applied. That fixture is what forced these numbers down.
	 *
	 * 60 is still ~3x the largest program any real meeting books, and the role
	 * sheets get by on 8.
	 */
	programRows: 60,
	tableTopicsRows: 40,
	/**
	 * How many attendee names one roster line prints before it says "+N more".
	 *
	 * Bounds the JOIN, not just the joined string. `names()` used to concatenate
	 * the whole roster and cap the result, which left the build cost scaling
	 * with the input — the #519 shape, one frame up from the fix. The roster is
	 * anonymously growable: `submitGuestBook` is public, unthrottled, and each
	 * distinct guest becomes an attendance row.
	 */
	nameRows: 100,
	/**
	 * And how long the JOINED roster line may be.
	 *
	 * Both bounds are needed. `nameRows` stops the build cost scaling with the
	 * input; this stops the RESULT being huge, since 100 names at `name` code
	 * points each is 12,000. Capping the join is cheap only because `nameRows`
	 * already ran — that ordering is the whole lesson of the #519 defect.
	 */
	namesLine: 2_000,
} as const;
