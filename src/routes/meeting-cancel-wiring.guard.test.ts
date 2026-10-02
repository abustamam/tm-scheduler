// Route→component wiring pins for cancelling a meeting (#1057).
//
// Same mechanism and same reason as `meeting-chrome-wiring.guard.test.ts`:
// `club.$clubId.meeting.$meetingId.tsx` cannot render in jsdom (loader + server
// fns), so nothing behavioural observes the expressions at its call sites. The
// toolbar, the sheet and the builder are each tested THROUGH their props, and a
// component tested through its props cannot see a wrong prop (#319). Every pin
// below is a prop or a predicate that is same-typed with a plausible wrong
// expression, and silent when wrong — the page renders, it just lets a member
// write to a meeting the server will refuse, or never offers the officer the
// way back.
//
// The toolbar's three cancel props are OPTIONAL with defaults (unlike
// `wordOfTheDay`, which is required for exactly the drift this guards), so a
// route that dropped one would hide Cancel for every officer with typecheck
// and the toolbar suite green. This file is the half a prop default cannot see.
//
// COMMENT-BLIND (`readSource`): every assertion is of the "must BE present"
// form and this header quotes several of the patterns it checks for.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(ROUTES, "club.$clubId.meeting.$meetingId.tsx");
const TOOLBAR = resolve(ROUTES, "../components/club/meeting-toolbar.tsx");
const SCHEDULE = resolve(ROUTES, "_authed/schedule.tsx");
const MEETINGS_FNS = resolve(ROUTES, "../server/meetings.ts");

/** The source between a marker and the next top-level `export const`. */
function declarationAfter(src: string, marker: string): string {
	const at = src.indexOf(marker);
	expect(at, `expected ${marker} in source`).toBeGreaterThan(-1);
	const next = src.indexOf("\nexport const ", at + marker.length);
	return src.slice(at, next === -1 ? undefined : next);
}

/**
 * One of the route component's inner handlers, sliced to its own body: from
 * `async function <name>()` to the next function declared at the same depth
 * (one tab in). The `release-slot-seam.guard.test.ts` pattern, for the reason
 * it gives: a pin on the whole file is satisfied by the SAME call in a
 * neighbouring handler, so "doRestore re-runs the loader" passes on
 * `doReopen`'s `router.invalidate()` with doRestore's deleted.
 */
function handlerBody(src: string, name: string): string {
	const start = src.indexOf(`\tasync function ${name}()`);
	expect(start, `no ${name} handler in the meeting route`).toBeGreaterThan(-1);
	const rest = src.slice(start + 1);
	const next = rest.search(/\n\t(?:async )?function /);
	const body = next === -1 ? rest : rest.slice(0, next);
	// The vacuity floor: an over-short slice passes a negative for nothing and
	// an over-long one lends a neighbour's call to this handler.
	expect(body.length).toBeGreaterThan(100);
	expect(body.split("async function ").length - 1).toBe(1);
	return body;
}

describe("meeting route: cancel wiring (#1057)", () => {
	const src = readSource(ROUTE);

	it("hands the toolbar all three cancel props, from the route's own derivations", () => {
		expect(src).toContain("cancelled={cancelled}");
		expect(src).toContain("canCancel={canCancel}");
		expect(src).toContain("onCancel={() => setCancelConfirmOpen(true)}");
	});

	it("derives `cancelled` from the status and `canCancel` from lock, cancel and the club-local day", () => {
		expect(src).toContain(
			"const cancelled = isMeetingCancelled(meeting.status)",
		);
		expect(
			src,
			"Cancel must be withheld on a locked, already-cancelled or past meeting; " +
				"`applyCancelMeeting` refuses all three, so a wider predicate here is a " +
				"button that always fails.",
		).toContain("const canCancel = !locked && !cancelled && !datePassed");
	});

	it("the confirm's write and the banner's Restore call the two handlers, not each other", () => {
		expect(src).toContain("onClick={doCancel}");
		expect(src).toContain("onClick={doRestore}");
		expect(src).toContain(
			"await cancelMeeting({ data: { meetingId: meeting.id } })",
		);
		expect(src).toContain(
			"await restoreMeeting({ data: { meetingId: meeting.id } })",
		);
	});

	it("locks the viewer on a cancelled meeting, after the shared resolver", () => {
		expect(
			src,
			"a cancelled meeting must be read-only for everyone: " +
				"`lockedViewer` over the resolved viewer, so claim / assign / availability " +
				"controls go the way the lock takes them.",
		).toContain(
			"const viewer = cancelled ? lockedViewer(resolvedViewer) : resolvedViewer",
		);
	});

	it("hides the attendance rail, the lineup blast and the ballot console on a cancelled meeting", () => {
		expect(src).toContain('!cancelled && (panelMode === "plan"');
		expect(src).toContain("!cancelled &&\n\t\t(effectiveCanManage ||");
		expect(src).toContain(
			"(isVoteCounter || effectiveCanManage) && !cancelled ?",
		);
	});

	it("the banner comes FIRST in the status chain and carries the officer controls", () => {
		const banner = src.indexOf('data-testid="cancelled-banner"');
		const lockedBanner = src.indexOf("{MEETING_LOCKED_MESSAGE}");
		expect(banner).toBeGreaterThan(-1);
		expect(
			banner,
			"the cancelled banner must precede the locked / already-taken-place arms, " +
				"or a past cancelled meeting tells members it took place.",
		).toBeLessThan(lockedBanner);
		const bannerSrc = src.slice(banner, lockedBanner);
		expect(bannerSrc).toContain("{effectiveCanManage ? (");
		expect(bannerSrc).toContain("View notice");
		expect(bannerSrc).toContain("{!datePassed ? (");
		expect(bannerSrc).toContain("Restore");
	});

	it("moves a bare-date URL to the uuid URL after cancelling, and opens the notice on arrival", () => {
		expect(src).toContain("if (meetingKeyParam !== meeting.id) {");
		expect(src).toContain("cancellationNoticeHref(clubId, meeting.id)");
		expect(src).toContain("isCancellationNoticeRequested(search)");
		expect(src).toContain(
			"if (noticeRequested && cancelled && effectiveCanManage) {",
		);
	});

	it("on the uuid URL already, doCancel re-runs the loader and opens the notice in place", () => {
		// Sliced to doCancel's OWN body (review of #1084): the file-wide pins
		// above are satisfied with the else branch deleted, and an officer who
		// cancels from a uuid URL is then left on a stale page with no notice.
		const body = handlerBody(src, "doCancel").replace(/\s+/g, " ");
		expect(body).toContain(
			"} else { await router.invalidate(); setNoticeOpen(true); }",
		);
		// Both arms: the navigation is the other half of the same `if`.
		expect(body).toContain(
			"if (meetingKeyParam !== meeting.id) { await router.navigate({ href: cancellationNoticeHref(clubId, meeting.id), }); }",
		);
	});

	it("doRestore re-runs the loader after the write", () => {
		const body = handlerBody(src, "doRestore").replace(/\s+/g, " ");
		expect(body).toContain(
			"await restoreMeeting({ data: { meetingId: meeting.id } }); toast.success(",
		);
		expect(
			body,
			"without the invalidate the banner, the toolbar and the agenda keep " +
				"showing the meeting as cancelled after a successful restore.",
		).toContain("await router.invalidate();");
	});

	it("the in-room strip is withheld on a cancelled meeting", () => {
		expect(
			src,
			"the strip's Vote link appears whenever a category is open, and " +
				"cancelling does not close vote sessions — so without `!cancelled` a " +
				"scanned QR on today's cancelled meeting offers a Vote castVote refuses.",
		).toContain(
			'const inRoom = isInRoom(search) && phase === "today" && !cancelled;',
		);
	});

	it("builds the notice's holders from the agenda's own slot rows", () => {
		expect(src).toContain("holdersFromSlots(slots)");
		expect(src).toContain("holders={cancellationHolders}");
		expect(src).toContain("{effectiveCanManage && cancelled && noticeOpen ? (");
	});
});

describe("toolbar: the cancel axis (#1057)", () => {
	const src = readSource(TOOLBAR);

	it("the edit group and Promote key off `canManage && !cancelled`", () => {
		expect(src).toContain("const canEdit = canManage && !cancelled");
		expect(src).toContain("{canEdit ? (");
		expect(src).toContain("{canEdit && !locked && hasAddableRoles ? (");
		expect(src).toContain("{canEdit && !locked && canComplete ? (");
	});

	it("Cancel is gated on the route's `canCancel` beside the lock", () => {
		expect(src).toContain("{canEdit && !locked && canCancel ? (");
	});
});

describe("schedule: the officer-only cancelled list (#1057)", () => {
	it("the loader asks only for an effective admin, and the server fn re-asks with the cancel's own gate", () => {
		const schedule = readSource(SCHEDULE);
		expect(schedule).toContain("effectiveAdminClub(context)");
		expect(schedule).toContain(
			"? listCancelledMeetings({ data: { clubId } }).catch(() => none)",
		);
		expect(schedule).toContain(
			"{canManageOthers && cancelled.length > 0 && clubKey ? (",
		);

		const fns = readSource(MEETINGS_FNS);
		for (const name of [
			"cancelMeeting",
			"restoreMeeting",
			"listCancelledMeetings",
		]) {
			const decl = declarationAfter(
				fns,
				`export const ${name} = createServerFn`,
			);
			expect(
				decl,
				`${name} must gate on requireClubRole(…, ["admin"]) — the rule that admits ` +
					"an admin and a member with an open office, and refuses an archived club.",
			).toContain("requireClubRole(currentUser.id, ");
			// `["admin"]` however the formatter wraps it.
			expect(decl).toMatch(/\[\s*"admin",?\s*\]/);
		}
	});
});
