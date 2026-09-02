/**
 * The personal meeting page's CALL-SITE wiring (#665).
 *
 * ## Why a source guard and not a render test
 *
 * The body of the page now lives in `components/club/personal-meeting-body.tsx`
 * and IS render-tested. What stays here is the part vitest still cannot reach:
 * the route module itself, which imports `#/server/personal-meeting` → `#/db`
 * and throws `DATABASE_URL is not set` on import. Everything this file asserts
 * is an EXPRESSION on that route — precisely CLAUDE.md's "a component tested
 * through its props cannot see a WRONG prop", where the props are computed.
 *
 * Two real defects lived exactly there:
 *
 * 1. The route passed the raw `$meetingId` URL segment to a seam that required
 *    a uuid. That segment is a club-local DATE KEY in every producer in the app
 *    (`meetingUrlKey`), so a key-shaped link rendered "this link is out of date".
 * 2. The seam took no club, so a club-A URL carrying a club-B meeting id
 *    rendered club B's meeting — and the route then wrote a club-B member into
 *    club A's `localStorage` identity slot.
 *
 * ## Which reader, and why it matters
 *
 * `readSource` blanks comments. That is correct for "this pattern must BE
 * present" assertions, where a comment merely MENTIONING the pattern would be a
 * false PASS — and this file's own header quotes several of the patterns below.
 *
 * It is WRONG for "the offender must be ABSENT" assertions. `guard-source.ts`
 * states why: the stripper is a lexer that does not track string or template
 * literals, so a `//` inside one blanks the rest of that line and can erase the
 * offending code from the text being searched — a false PASS on exactly the
 * half that exists to catch a regression. An earlier version of this file ran
 * its one negative through `readSource` while its header claimed it had none.
 * So negatives read RAW, matching `public-readers-archive-gate.guard.test.ts`'s
 * `readStripped`/`readRaw` split.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.me.tsx";
const SEAM = "src/server/personal-meeting-logic.ts";

/** Comment-blind — for "this pattern must BE present". */
const src = readSource(ROUTE);
const seamSrc = readSource(SEAM);
/** Verbatim — for "this offender must be ABSENT". Never `readSource`. */
const rawRoute = readFileSync(resolve(ROOT, ROUTE), "utf8");
const rawSeam = readFileSync(resolve(ROOT, SEAM), "utf8");

describe("personal meeting page → seam wiring (#665)", () => {
	it("sends the raw URL segment as a KEY, with the club beside it", () => {
		expect(src).toContain("meetingKey: meetingId");
		expect(src).toContain("clubId: clubUuid");
	});

	it("resolves the club uuid from route context, not from the URL param", () => {
		// `params.clubId` is a slug OR a uuid; the shell's `beforeLoad` already
		// resolved it. Passing the raw param would hand the seam a slug, which
		// `isReadableClub` rejects as a non-uuid — a silent not-found.
		expect(src).toMatch(
			/const\s*\{\s*clubUuid\s*\}\s*=\s*Route\.useRouteContext/,
		);
	});

	it("keys the STORED IDENTITY on the URL param, not the club uuid", () => {
		// The gate stores under `clubSlug={clubId}` (the raw param). Seeding under
		// `clubUuid` instead writes an identity nothing ever reads — every `?as=`
		// link would silently fail to seed, with the whole suite green.
		expect(src).toContain("useCurrentMember(clubId)");
		expect(rawRoute).not.toContain("useCurrentMember(clubUuid)");
	});

	it("gates the seam through the club-scoped public resolver, with no fallback", () => {
		// Positive: the gated resolver is called.
		expect(seamSrc).toContain("resolvePublicMeetingKey");
		expect(seamSrc).toContain("if (!meetingId) return null;");
		// Negative, RAW: the mutation the archive-gate guard's own header names —
		// `gated ?? await resolveMeetingKey(...)` — satisfies the positive above
		// and must still fail. Note `resolvePublicMeetingKey(` does not contain
		// the substring `resolveMeetingKey(`, so this cannot false-positive.
		expect(rawSeam).not.toContain("resolveMeetingKey(");
	});

	it("writes against the RESOLVED meeting uuid, never the URL segment", () => {
		// Both writers validate `z.string().uuid()`, so passing the date-key
		// segment would reject the write AFTER the page rendered fine.
		const body = readSource("src/components/club/personal-meeting-body.tsx");
		expect(body).toContain("const meetingUuid = view.meeting.id");
		expect(body).toMatch(
			/setPlannedAttendance\(\{[\s\S]{0,200}meetingId: meetingUuid/,
		);
		expect(body).toMatch(
			/markUnavailableReleasing\(\{[\s\S]{0,200}meetingId: meetingUuid/,
		);
	});

	it("keys the query on the club, because the meeting key is club-local", () => {
		expect(src).toContain('queryKey: ["personal-meeting", clubUuid, meetingId');
	});

	it("routes ?as= through resolveAsSeed, on a SUCCESSFUL read only", () => {
		// Replacing this effect's body with a direct
		// `setMember(view.data.member)` keeps every other gate green — including
		// resolveAsSeed's own unit tests, which simply stop mattering — while
		// three enforced rules vanish at once.
		expect(src).toContain("resolveAsSeed({");
		expect(src).toMatch(/resolveAsSeed\(\{[\s\S]{0,240}asParam: as/);
		expect(src).toMatch(/resolveAsSeed\(\{[\s\S]{0,240}sessionMember/);
		expect(src).toMatch(
			/resolveAsSeed\(\{[\s\S]{0,240}candidate: view\.data\?\.member/,
		);
		// The browser's own identity must reach the decision, or it cannot refuse
		// to re-point a device that is already someone else.
		expect(src).toMatch(/resolveAsSeed\(\{[\s\S]{0,240}existingPick: picked/);
		// `isSuccess`, NOT `!isPending` — an error must leave a valid ?as= alone.
		expect(src).toContain("view.isSuccess");
		// Only the decision may write the identity.
		expect(src).toMatch(/if \(decision\.seed\) setMember\(decision\.seed\)/);
		expect(rawRoute).not.toMatch(/setMember\((?!decision\.seed\))/);
	});

	it("strips the param with a REPLACE navigation", () => {
		// Without `replace`, a back-tap re-applies someone else's identity and the
		// id rides along into history and any re-share of the URL.
		expect(src).toMatch(/navigate\(\{[\s\S]{0,160}replace: true/);
	});

	it("prefers a SESSION identity over the ?as= param", () => {
		// Precedence, not presence. `as ?? sessionMember?.id ?? …` would let a
		// forwarded link make a signed-in officer write another member's row from
		// their own browser.
		expect(src).toContain(
			"const targetMemberId = sessionMember?.id ?? as ?? picked?.id ?? null",
		);
	});

	it("offers the re-pick affordance to exactly the visitors who can use it", () => {
		// `canRepick={!!sessionMember}` (inverted) takes the correction affordance
		// away from the forwarded-link recipient who needs it and gives it to the
		// signed-in member who cannot act on it — the #319 shape.
		expect(src).toContain("canRepick={!sessionMember}");
	});
});

describe("personal meeting body → duty wiring (#665)", () => {
	const body = readSource("src/components/club/personal-meeting-body.tsx");
	const rawBody = readFileSync(
		resolve(ROOT, "src/components/club/personal-meeting-body.tsx"),
		"utf8",
	);

	it("computes duty state PER SLOT, not per member", () => {
		// TODOS.md's `DutyContext` trap: the context mixes meeting-scoped fields
		// with the slot-scoped `speechTitle`, so ONE context per member marks both
		// of a member's speaker slots done off a single title. `defaultCount` is 3,
		// so holding two is ordinary. The seam is per-slot; this pins the consumer.
		expect(body).toContain("speechTitle: role.speechTitle");
		expect(body).toMatch(
			/view\.roles\.map\(\(role\)[\s\S]{0,600}dutiesForRole\(\{/,
		);
		expect(rawBody).not.toMatch(/speechTitle: view\.roles\[0\]/);
	});

	it("closes the write window on a meeting whose DAY has passed", () => {
		// `isMeetingLocked` alone is completed-only, and clubs routinely never
		// press Complete — so a month-old meeting stays "scheduled" while its link
		// sits in the chat, and one tap would release roles from a meeting that
		// already happened.
		expect(body).toContain("isMeetingOver({");
		expect(body).toMatch(/const writesClosed =[\s\S]{0,200}isMeetingOver/);
	});

	it("never gates the confirm dialog on the cached role list", () => {
		// `holdsRole` comes from a cached query. Gating the CONFIRM on it means a
		// role assigned after page load is released on one tap with no warning —
		// the same staleness that made the WRITE unconditional.
		expect(body).toMatch(
			/const answerNo = useCallback\(\(\) => setConfirmRelease\(true\)/,
		);
		expect(rawBody).not.toMatch(/if \(holdsRole\)\s*\{\s*setConfirmRelease/);
	});

	it("declines through the releasing writer, never a plain not_coming", () => {
		// Positive on the shape rather than the spelling of the control flow.
		expect(body).toMatch(
			/markUnavailableReleasing\(\{[\s\S]{0,240}memberId: view\.member\.id/,
		);
		// RAW negative: a plain not_coming write leaves the member declined and
		// still holding the role.
		expect(rawBody).not.toMatch(
			/setPlannedAttendance\(\{[\s\S]{0,280}status: "not_coming"/,
		);
	});
});
