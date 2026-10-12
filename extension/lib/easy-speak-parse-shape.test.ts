/**
 * A page that is not the page it should be is never read as "empty" (#1047, third review round).
 *
 * Every parser the walk relies on tells "the expected structure, with nothing in it" (a real
 * empty list: it parses to an empty result) from "not this page" (an error page, another page
 * served for the URL: a PageShapeError, which the walk turns into an abort inside `parse`, so
 * the page is never cached). Before, an unreadable member list was an export with no people.
 * Run: cd extension && bunx vitest run lib/easy-speak-parse-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	PageShapeError,
	checkEvaluationsPage,
	checkRoleHistory,
	checkRolesByMember,
	parseClubData,
	parseMeetingList,
	parseMemberList,
	parseMentoring,
	parseRequestForm,
	parseSpeechList,
	parseVisitorsIntroduced,
} from "./easy-speak-parse";
import { emptyMeetingList, fixtureDoc, memoryStore, parseHtml, readFixture, setup } from "./easy-speak-test-kit";

/** A signed-in Easy-Speak page that is none of the pages the walk reads: an error page. */
const ERROR_PAGE = `<html><body><table class="toprow"><tbody><tr><td align="right" class="reverse"><a href="https://easy-speak.org/profile.php?mode=editprofile" class="reverse">Welcome back Avery Alderfinch</a>&nbsp;&nbsp;[fixtureuser]&nbsp;&nbsp;</td></tr></tbody></table><p>Something went wrong. Please try again later.</p></body></html>`;
const errorDoc = () => parseHtml(ERROR_PAGE);

/** The fixture with its data rows taken out: the same page for a club with nothing in the list. */
function withoutRows(name: string, isRow: (tr: Element) => boolean): Document {
	const doc = fixtureDoc(name);
	for (const tr of Array.from(doc.querySelectorAll("table.forumline > tbody > tr, table.forumline > tr"))) {
		if (isRow(tr)) tr.remove();
	}
	return doc;
}

describe("each parser rejects a page that is not its page", () => {
	const cases: [string, (d: Document) => unknown, string[]][] = [
		["member list", parseMemberList, ["club-data.html", "meeting-list.html", "speech-list.html", "chart-8-mentors.html"]],
		["club data", parseClubData, ["member-list.html", "meeting-list.html", "speech-list.html"]],
		["meeting list", parseMeetingList, ["member-list.html", "club-data.html", "speech-list.html"]],
		["speech list", parseSpeechList, ["club-data.html", "member-list.html", "meeting-list.html"]],
		["request form", parseRequestForm, ["member-list.html", "club-data.html", "speech-list.html"]],
		["mentors chart", parseMentoring, ["chart-7-visitors-introduced.html", "chart-1-role-history.html", "member-list.html"]],
		["visitors introduced chart", parseVisitorsIntroduced, ["chart-8-mentors.html", "chart-1-role-history.html", "member-list.html"]],
		["role history chart", checkRoleHistory, ["chart-8-mentors.html", "member-list.html", "club-data.html"]],
		["roles by member chart", checkRolesByMember, ["member-list.html", "club-data.html", "meeting-list.html"]],
		["evaluations page", checkEvaluationsPage, ["member-list.html", "club-data.html", "chart-7-visitors-introduced.html"]],
	];
	for (const [what, parse, others] of cases) {
		it(`${what}: an error page and other pages are a PageShapeError, not an empty result`, () => {
			expect(() => parse(errorDoc())).toThrow(PageShapeError);
			expect(() => parse(parseHtml("<html><body></body></html>"))).toThrow(PageShapeError);
			for (const other of others) expect(() => parse(fixtureDoc(other)), other).toThrow(PageShapeError);
		});
	}
});

describe("a page with the structure and nothing in it still parses, empty", () => {
	it("member list with no member row", () => {
		const doc = withoutRows("member-list.html", (tr) => !!tr.querySelector('span[id^="email_status_"]'));
		expect(doc.querySelector('span[id^="email_status_"]')).toBeNull();
		expect(parseMemberList(doc)).toEqual({ people: [], pages: 1 });
	});

	it("club data needs both the Club Number and the Name row", () => {
		const html = readFixture("club-data.html");
		expect(() => parseClubData(parseHtml(html.replace('<span class="gen">Name</span>', '<span class="gen">Label</span>')))).toThrow(PageShapeError);
		expect(() => parseClubData(parseHtml(html.replace("Club Number", "Number of Club")))).toThrow(PageShapeError);
	});

	it("member list whose rows have no readable member is not an empty club", () => {
		const doc = fixtureDoc("member-list.html");
		for (const a of Array.from(doc.querySelectorAll('a[href*="mode=viewprofile"]'))) a.remove();
		expect(() => parseMemberList(doc)).toThrow(PageShapeError);
	});

	it("meeting list for a year with no meetings", () => {
		expect(parseMeetingList(parseHtml(emptyMeetingList()))).toEqual([]);
	});

	it("speech list with no speech row", () => {
		const doc = withoutRows("speech-list.html", (tr) => !!tr.querySelector("td.row1, td.row2"));
		expect(parseSpeechList(doc)).toEqual([]);
	});

	it("visitors-introduced chart with a header and no rows (what a member sees)", () => {
		const doc = withoutRows("chart-7-visitors-introduced.html", (tr) => !!tr.querySelector("td.row1, td.row2"));
		expect(parseVisitorsIntroduced(doc)).toEqual([]);
	});

	it("mentors chart with no rows", () => {
		const doc = withoutRows("chart-8-mentors.html", (tr) => !!tr.querySelector("td.row1, td.row2"));
		const parsed = parseMentoring(doc);
		expect(parsed.mentors).toEqual([]);
		expect(parsed.joined.size).toBe(0);
	});

	it("the real pages still pass", () => {
		expect(parseMemberList(fixtureDoc("member-list.html")).people).toHaveLength(9);
		expect(() => checkRoleHistory(fixtureDoc("chart-1-role-history.html"))).not.toThrow();
		expect(() => checkRolesByMember(fixtureDoc("chart-4-roles-by-member.html"))).not.toThrow();
		expect(() => checkEvaluationsPage(fixtureDoc("my-evaluations.html"))).not.toThrow();
	});
});

describe("the walk aborts on an unreadable page and never caches it", () => {
	it("the club-data page served as the member list is not an export with no people (the repro)", async () => {
		const store = memoryStore();
		const first = setup({
			store,
			override: (url) => (url.endsWith("/memberlist.php") ? readFixture("club-data.html") : undefined),
		});
		await expect(first.run()).rejects.toThrow(/member list is not the Easy-Speak page it should be/);
		expect(store.data.has("page:memberlist")).toBe(false);
		// The site is fine on the next press: it asks for the member list again and finishes.
		const second = setup({ store, clock: first.c });
		const { bundle } = await second.run();
		expect(second.log.map((r) => new URL(r.url).pathname)).toContain("/memberlist.php");
		expect(bundle.people.length).toBeGreaterThan(0);
	});

	it("every HTML page the walk reads is rejected when the server answers with an error page, and not stored", async () => {
		const probe = setup();
		await probe.run();
		const walk = probe.log.map((r) => new URL(r.url).pathname);
		let aborted = 0;
		let forgiven = 0;
		for (const [i, path] of walk.entries()) {
			if (path.startsWith("/api/")) continue;
			const store = memoryStore();
			let n = 0;
			const s = setup({ store, override: () => (n++ === i ? ERROR_PAGE : undefined) });
			if (path === "/my_evaluations.php") {
				// Evaluations are best-effort: the walk finishes without them and does not keep the page.
				const { bundle } = await s.run();
				expect(bundle.evaluations).toEqual([]);
				expect(s.progress.some((l) => /evaluations skipped: .*not the Easy-Speak page/.test(l))).toBe(true);
				forgiven += 1;
				continue;
			}
			await expect(s.run(), `request ${i} ${path}`).rejects.toThrow(/not the Easy-Speak page it should be|not a readable meeting page/);
			aborted += 1;
			expect(JSON.stringify([...store.data.values()])).not.toContain("Something went wrong");
			expect([...store.data.keys()].filter((k) => k.startsWith("page:"))).toHaveLength(i);
		}
		// The club page, member list, each year's list, three meetings, speeches, a request form, three charts.
		expect(aborted).toBeGreaterThanOrEqual(20);
		expect(forgiven).toBe(1);
	});
});
