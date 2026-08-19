/**
 * DP3 single-instance guard (planned-attendance PR 3, roll-mode Task 1
 * review, C2).
 *
 * `enqueue`/`readQueue`/etc. are keyed by meetingId, and after this PR two
 * components (`MeetingMinutes`, and later the attendance panel absorbing
 * roll call) write into that ONE persisted queue. `useOfflineMinutes` must be
 * instantiated exactly ONCE per meeting — the route owns that instance and
 * hands it down as the `offline` prop. Two live instances for the same
 * meeting would each own their own `draining` flag and race the SAME
 * IndexedDB queue, replaying a stale status over a newer one — silently: no
 * thrown error, no failing assertion in any behavioural test, because the
 * race depends on which of two components happens to be mounted, not on any
 * value either one computes wrong.
 *
 * `<MeetingMinutes>`'s `offline` prop is OPTIONAL — deliberately, so this
 * component's own unit tests (which render it standalone, with no route-level
 * instance to share) don't all need editing. That optionality is exactly the
 * hole: nothing in the type system or in any behavioural test stops a NEW
 * production caller (a print view, a careless route edit) from rendering
 * `<MeetingMinutes>` with no `offline` prop and silently getting a private
 * fallback instance (`MeetingMinutesSelfContained`) racing the route's real
 * one for the same meeting. This guard is the only thing that can see that.
 *
 * Two checks, two different reader modes (`src/test/guard-source.ts` — each
 * assertion class needs the opposite one, and blanket-applying either is a
 * real bypass, not a hypothetical one):
 *
 *  1. "must be present" (does this file call `useOfflineMinutes(`?) →
 *     comment-blind `readSource`, so a comment merely NAMING the hook cannot
 *     satisfy it.
 *  2. "must be present" (does this `<MeetingMinutes` tag carry `offline=`?) →
 *     also `readSource`, for the same reason.
 *
 * Both of this guard's checks are the SAME "must be present" class (not the
 * "offender list must be empty" class `ti-wordmark.guard.test.ts` /
 * `server-modules.guard.test.ts` use), so both correctly read stripped
 * source. There is no raw/negative half here.
 *
 * Mutation record. Verified this guard actually fails, not just exists:
 *  - Added a second `useOfflineMinutes({...})` call in a throwaway file under
 *    `src/components/club/` → check 1 failed (`callers` gained an unreviewed
 *    entry). Removed it; check 1 passed again.
 *  - Removed `offline={offlineMinutes}` from the route's `<MeetingMinutes`
 *    render → check 2 failed (offender list non-empty). Restored it; check 2
 *    passed again.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every non-test, non-generated .ts/.tsx file under src/, recursively. */
function walkSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			out.push(...walkSourceFiles(full));
		} else if (
			/\.(ts|tsx)$/.test(entry) &&
			!entry.includes(".test.") &&
			!entry.endsWith(".gen.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

const FILES = walkSourceFiles(SRC);

/**
 * The reviewed, exhaustive set of files allowed to CALL `useOfflineMinutes(`
 * (a real call — `useOfflineMinutes({` — not the hook's own
 * `export function useOfflineMinutes(` declaration in `use-offline-minutes.ts`,
 * which is excluded below rather than listed here). A THIRD file appearing in
 * this list has not been reviewed for the race this guard exists to prevent:
 * either it must be rewired to receive the route's shared instance instead of
 * creating its own, or — if it genuinely needs a new independent instance —
 * added here with a stated reason.
 */
const REVIEWED_CALL_SITES: Record<string, string> = {
	"routes/club.$clubId.meeting.$meetingId.tsx":
		"the ONE real, shared, per-meeting instance. Everything that reads or writes this meeting's offline queue must be handed THIS object.",
	"components/club/meeting-minutes.tsx":
		"MeetingMinutesSelfContained's private fallback, used ONLY when a caller renders <MeetingMinutes> with no `offline` prop. Reachable in production only if check 2 below has already been violated — a reviewed, intentional exception, not a silent gap.",
};

describe("useOfflineMinutes instance discipline (DP3)", () => {
	it("is called from no file beyond the reviewed set", () => {
		const callers = FILES.filter((f) => {
			if (f.endsWith("use-offline-minutes.ts")) return false; // the definition, not a call
			return /useOfflineMinutes\(\s*\{/.test(readSource(f));
		})
			.map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
			.sort();
		expect(
			callers,
			"a new useOfflineMinutes() call site needs review for the DP3 single-instance race — either hand it the route's shared instance, or add it to REVIEWED_CALL_SITES above with a stated reason",
		).toEqual(Object.keys(REVIEWED_CALL_SITES).sort());
	});

	it("every non-test <MeetingMinutes> render passes a real `offline` prop", () => {
		const OPEN_TAG_END = /\n[ \t]*\/?>/;
		const offenders: string[] = [];
		for (const f of FILES) {
			const src = readSource(f);
			const starts = [...src.matchAll(/<MeetingMinutes\b/g)].map(
				(m) => m.index ?? -1,
			);
			for (const start of starts) {
				const rest = src.slice(start);
				const endMatch = OPEN_TAG_END.exec(rest);
				const end = endMatch
					? start + endMatch.index + endMatch[0].length
					: rest.length;
				const tag = src.slice(start, end);
				if (!/offline=\{/.test(tag)) {
					offenders.push(`${f.slice(SRC.length + 1)}:${start}`);
				}
			}
		}
		expect(
			offenders,
			"every production <MeetingMinutes> render must pass offline={<the route's shared useOfflineMinutes() instance>} — omitting it silently falls back to a private instance that can race the route's",
		).toEqual([]);
	});

	// Sanity check that the walk actually reaches the one known real render —
	// an empty `offenders` list from a walk that found NOTHING would pass the
	// check above vacuously.
	it("control: the walk actually finds the route's real render", () => {
		const routeFile = FILES.find((f) =>
			f.endsWith("club.$clubId.meeting.$meetingId.tsx"),
		);
		expect(
			routeFile,
			"expected the meeting route to be on the walk",
		).toBeTruthy();
		const src = readFileSync(routeFile as string, "utf8");
		expect(src).toContain("<MeetingMinutes");
	});
});
