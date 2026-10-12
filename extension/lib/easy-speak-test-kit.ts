/**
 * Test support for the Easy-Speak export (#1047): loads the committed fixtures
 * and serves them as a fake Easy-Speak for the walk. Not a test itself.
 */
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";

const DIR = new URL("./__fixtures__/easy-speak/", import.meta.url);

export const readFixture = (name: string): string =>
	readFileSync(new URL(name, DIR), "utf8");

export const fixturePath = (name: string): URL => new URL(name, DIR);

/** linkedom's document, typed as the DOM one the parsers take. */
export const parseHtml = (html: string): Document =>
	new DOMParser().parseFromString(html, "text/html") as unknown as Document;

export const fixtureDoc = (name: string): Document => parseHtml(readFixture(name));

/** The meeting list with no meetings: what Easy-Speak returns for a year the club did not exist. */
export function emptyMeetingList(): string {
	const doc = fixtureDoc("meeting-list.html");
	for (const a of Array.from(
		doc.querySelectorAll('table.forumline a[href*="view_meeting.php?t="]'),
	)) {
		let tr: Element | null = a;
		while (tr && tr.tagName !== "TR") tr = tr.parentElement;
		tr?.remove();
	}
	return doc.toString();
}

/** A request form for a speech that has no introduction yet. */
export function blankRequestForm(speechId: string): string {
	return readFixture("speech-request-intro.html")
		.replace(/Our next speaker grows tomatoes[^<"]*/g, "")
		.replace("1473688", speechId);
}

export interface FakeRequest {
	url: string;
	method: string;
	body: string | null;
	startedAt: number;
}

/**
 * The fixtures as a site: every URL the walk asks for maps to a page. The
 * meeting list answers for 2026 only; any other year is empty.
 */
export function fakeEasySpeak(opts: {
	clock: () => number;
	log: FakeRequest[];
	failOn?: (url: string) => boolean;
}) {
	const meetings: Record<string, string> = {
		"644360": "meeting-upcoming.html",
		"644304": "meeting-completed.html",
		"644363": "meeting-table-topics.html",
	};
	const charts: Record<string, string> = {
		"1": "chart-1-role-history.html",
		"4": "chart-4-roles-by-member.html",
		"7": "chart-7-visitors-introduced.html",
		"8": "chart-8-mentors.html",
	};
	const page = (body: string) => ({
		ok: true,
		status: 200,
		text: async () => body,
	});
	return async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? init.body : null;
		opts.log.push({ url, method, body, startedAt: opts.clock() });
		if (opts.failOn?.(url)) return { ok: false, status: 500, text: async () => "" };
		const u = new URL(url);
		const p = u.pathname;
		if (p === "/clubdata.php") return page(readFixture("club-data.html"));
		if (p === "/memberlist.php") return page(readFixture("member-list.html"));
		if (p === "/meeting_list.php") {
			const year = new URLSearchParams(body ?? "").get("start_year");
			return page(year === "2026" ? readFixture("meeting-list.html") : emptyMeetingList());
		}
		if (p === "/view_meeting.php") {
			const file = meetings[u.searchParams.get("t") ?? ""];
			if (file) return page(readFixture(file));
		}
		if (p === "/tm_all_speeches.php") return page(readFixture("speech-list.html"));
		if (p === "/request_speech.php") {
			const s = u.searchParams.get("s") ?? "";
			return page(s === "1473688" ? readFixture("speech-request-intro.html") : blankRequestForm(s));
		}
		if (p === "/memberchart.php") {
			const file = charts[u.searchParams.get("chart") ?? ""];
			if (file) return page(readFixture(file));
		}
		if (p === "/my_evaluations.php") return page(readFixture("my-evaluations.html"));
		if (p === "/api/v1/evaluations.php/my-evaluations") return page(readFixture("my-evaluations.json"));
		const ev = /^\/api\/v1\/evaluations\.php\/eval\/(\d+)$/.exec(p);
		if (ev) return page(readFixture(`evaluation-${ev[1]}.json`));
		return { ok: false, status: 404, text: async () => "not found" };
	};
}
