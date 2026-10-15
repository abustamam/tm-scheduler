/**
 * The dashboard's mentor wiring (#1209), pinned from source. The route module
 * reaches `#/db` through its server fns and cannot be rendered in vitest, and
 * every prop below is typed loosely enough that a swap compiles: `outgoing`
 * and `incoming` both read as a request, and a dropped `now` or `timezone` is
 * optional. So the JSX is read as text, as `mentorship-authz.guard.test.ts`
 * does for the server fns.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

function element(name: string): string {
	const at = SRC.indexOf(`<${name}\n`);
	expect(at, `<${name}> missing from dashboard.tsx`).toBeGreaterThanOrEqual(0);
	const end = SRC.indexOf("/>", at);
	expect(end).toBeGreaterThan(at);
	return SRC.slice(at, end);
}

describe("dashboard mentor wiring (#1209)", () => {
	// protects=the mentor's card gets the INCOMING requests (never outgoing), the
	// club's zone and the shared answer handler; the admin's card gets the club's
	// pending list (not the member's own incoming) and the zone; the member's
	// card gets the loader's pinned `now`;
	// fails_when=`outgoing` replaces `incoming`, `now` or `timezone` is dropped,
	// or the two request lists are swapped;
	// no_claim=what each card renders (their own component tests)
	it("hands each card the right list, the zone and the pinned clock", () => {
		const requests = element("MentorRequestsCard");
		expect(requests).toMatch(
			/requests=\{mentorRequests\?\.incoming \?\? \[\]\}/,
		);
		expect(requests).not.toMatch(/outgoing/);
		expect(requests).toMatch(/onDecide=\{decideRequest\}/);
		expect(requests).toMatch(/timezone=\{timezone\}/);

		const admin = element("ClubMentoringCard");
		expect(admin).toMatch(/pendingRequests=\{clubPendingRequests \?\? \[\]\}/);
		expect(admin).not.toMatch(/mentorRequests/);
		expect(admin).toMatch(/onDecide=\{decideRequest\}/);
		expect(admin).toMatch(/timezone=\{timezone\}/);

		expect(element("MentorshipCard")).toMatch(/now=\{now\}/);
	});

	// protects=the loader's two request reads land in the names the JSX uses: the
	// member's own read (`getMyMentorRequests`) in `mentorRequests`, the admin's
	// (`listClubPendingMentorRequests`) in `clubPendingRequests`;
	// fails_when=the two reads are bound to each other's names;
	// no_claim=the gates on the server fns (mentorship-authz.guard.test.ts)
	it("binds each read to the name its card is given", () => {
		const destructure = SRC.slice(
			SRC.indexOf("const ["),
			SRC.indexOf("] = await Promise.all"),
		);
		const order = [...destructure.matchAll(/\b(\w+),/g)].map((m) => m[1]);
		const reads = [
			...SRC.slice(SRC.indexOf("Promise.all([")).matchAll(
				/(getMyMentorRequests|listClubPendingMentorRequests)\(\{/g,
			),
		].map((m) => m[1]);
		expect(reads).toEqual([
			"getMyMentorRequests",
			"listClubPendingMentorRequests",
		]);
		expect(order.indexOf("mentorRequests")).toBeLessThan(
			order.indexOf("clubPendingRequests"),
		);
	});

	// protects=an answer's reload goes through `answerThenReload`, so a failed
	// reload after a landed answer cannot hide the welcome draft;
	// fails_when=`decideRequest` awaits `router.invalidate()` bare again;
	// no_claim=the helper's behaviour (mentor-request-shared.test.tsx)
	it("answers through answerThenReload", () => {
		const at = SRC.indexOf("function decideRequest(");
		expect(at).toBeGreaterThanOrEqual(0);
		const body = SRC.slice(at, SRC.indexOf("\n\t}\n", at));
		expect(body).toMatch(/answerThenReload\(/);
		expect(body).toMatch(
			/decideMentorRequest\(\{ data: \{ requestId, accept \} \}\)/,
		);
	});
});
