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
	 * The meeting theme. Unbounded on write (`meetings.ts` declares
	 * `theme: z.string().trim().optional()`) and reachable with NO session: the
	 * `tmod-self-assert` branch of `resolveMeetingAgendaAuthz` grants the write
	 * on a self-asserted `selfMemberId` alone. Bounding the write is filed
	 * separately; this is what stops it reaching the renderer meanwhile.
	 */
	theme: 200,
	/** Word of the Day. Already write-capped by #519; this covers older rows. */
	word: 120,
	/** A Table Topics topic. Unbounded on write in `minutes.ts`. */
	topic: 200,
	/** One attendance row's joined names — a concatenation of a whole club. */
	namesLine: 2_000,

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
	 * Flat to ~500, then super-linear. No real meeting books more than a few
	 * dozen program rows, so 200 is ~5x the plausible maximum and still an order
	 * of magnitude under the knee. The role sheets bound the same way
	 * (`RENDER_CAPS.speakerRows`).
	 */
	programRows: 200,
	tableTopicsRows: 100,
	awardRows: 50,
} as const;
