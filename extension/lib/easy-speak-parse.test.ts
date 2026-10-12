/**
 * Parser tests for the Easy-Speak export (#1047). Every page is a committed
 * fixture (`__fixtures__/easy-speak/`), saved from a real club and rewritten
 * with fake names; `README` in that folder says how, and which pages are hand-built.
 * Run: cd extension && bunx vitest run lib/easy-speak-parse.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	fixtureDoc,
	parseHtml,
	readFixture,
} from "./easy-speak-test-kit";
import {
	localToInstant,
	parseClubData,
	parseEsClubId,
	parseEvaluation,
	parseEvaluationList,
	parseMeeting,
	parseMeetingList,
	parseMemberList,
	parseMentoring,
	parseRequestForm,
	parseSpeechList,
	parseViewer,
	parseVisitorsIntroduced,
	stripCredentials,
} from "./easy-speak-parse";

const TZ = "America/Los_Angeles";
const upcoming = () => parseMeeting(fixtureDoc("meeting-upcoming.html"), "644360", TZ);
const completed = () => parseMeeting(fixtureDoc("meeting-completed.html"), "644304", TZ);

describe("page identity", () => {
	it("reads the signed-in user and the club id from the header every page carries", () => {
		const doc = fixtureDoc("meeting-upcoming.html");
		expect(parseViewer(doc)).toEqual({
			esUserId: "900001",
			username: "fixtureuser",
			name: "Avery Alderfinch",
		});
		expect(parseEsClubId(doc)).toBe("4242");
	});

	it("sees a page with no header as not signed in", () => {
		const login = parseHtml("<html><body><form>Username <input name=username></form></body></html>");
		expect(parseViewer(login).username).toBeNull();
	});
});

describe("club data and member list", () => {
	it("reads the club's number, name and IANA timezone", () => {
		expect(parseClubData(fixtureDoc("club-data.html"))).toEqual({
			number: "9999",
			name: "Fixture Speakers",
			timezone: "America/Los_Angeles",
		});
	});

	it("reads name, status and id from the member list and never a phone number", () => {
		const { people, pages } = parseMemberList(fixtureDoc("member-list.html"));
		expect(pages).toBe(1);
		expect(people).toHaveLength(9);
		expect(people[0]).toMatchObject({ status: "Member" });
		expect(people.every((p) => /^9\d{5}$/.test(p.esUserId))).toBe(true);
		expect(JSON.stringify(people)).not.toMatch(/555|\d{3}-\d{4}/);
		expect(Object.keys(people[0]).sort()).toEqual(["esUserId", "name", "status"]);
	});

	it("reports a second page rather than quietly reading one", () => {
		const html = readFixture("member-list.html").replace("Page <b>1</b> of <b>1</b>", "Page <b>1</b> of <b>3</b>");
		expect(parseMemberList(parseHtml(html)).pages).toBe(3);
	});
});

describe("meeting list", () => {
	it("returns each meeting id once, in page order", () => {
		expect(parseMeetingList(fixtureDoc("meeting-list.html"))).toEqual(["644363", "644360", "644304"]);
	});
});

describe("an upcoming meeting (t=644360)", () => {
	it("reads the header: time as an instant, venue, join link, theme, manager", () => {
		const m = upcoming();
		expect(m).toMatchObject({
			esMeetingId: "644360",
			// 7:00 pm America/Los_Angeles on 2026-10-13 is PDT, UTC-7.
			startsAt: "2026-10-14T02:00:00.000Z",
			venue: "Fixture Hall",
			joinUrl: "https://example.test/join/fixture",
			theme: "Fall in Love with Life",
			wordOfTheDay: null,
			manager: "Zephyr Ashlowe",
		});
	});

	it("falls back to the club's timezone when the title names none, and keeps local time when neither is known", () => {
		const html = readFixture("meeting-upcoming.html").replace(" at 7:00 pm America/Los_Angeles", " at 7:00 pm");
		expect(html).not.toContain("pm America/Los_Angeles");
		expect(parseMeeting(parseHtml(html), "644360", TZ)?.startsAt).toBe("2026-10-14T02:00:00.000Z");
		expect(parseMeeting(parseHtml(html), "644360", null)?.startsAt).toBe("2026-10-13T19:00:00");
	});

	it("has 3 speakers, each with a Pathways path, level, project and timing", () => {
		const speakers = upcoming()?.roles.filter((r) => /Speaker$/.test(r.role)) ?? [];
		expect(speakers.map((r) => r.role)).toEqual(["1st Speaker", "2nd Speaker", "3rd Speaker"]);
		expect(speakers[1].speech).toEqual({
			esSpeechId: null,
			title: null, // "TBA"
			path: "Presentation Mastery",
			level: 1,
			project: "Evaluation and Feedback - 2",
			minMin: 5,
			maxMin: 7,
			introduction: null,
		});
		expect(speakers[2].speech).toMatchObject({ level: 2, project: "Effective Body Language" });
		expect(speakers[0].speech?.title).toBe("Fixture Garden Tour");
	});

	it("links each of the 3 evaluators to the speaker they evaluate, by slot", () => {
		const roles = upcoming()?.roles ?? [];
		const slotOf = (label: string) => roles.find((r) => r.role === label)?.slot;
		const evaluators = ["1st Evaluator", "2nd Evaluator", "3rd Evaluator"];
		const speakers = ["1st Speaker", "2nd Speaker", "3rd Speaker"];
		evaluators.forEach((e, i) => {
			expect(roles.find((r) => r.role === e)?.evaluates).toBe(slotOf(speakers[i]));
		});
		expect(roles.find((r) => r.role === "General Evaluator")?.evaluates).toBeUndefined();
		// Slots are the row order, 1-based, and unique.
		expect(roles.map((r) => r.slot)).toEqual(roles.map((_, i) => i + 1));
	});

	it("reads a vacant role as no holder", () => {
		const ah = upcoming()?.roles.find((r) => r.role === "Ah Master");
		expect(ah?.holder).toBeNull();
		expect(upcoming()?.roles.find((r) => r.role === "Toastmaster")?.holder?.name).toBe("Zephyr Ashlowe");
	});

	it("reads replies: attending, online, not attending and unknown, plus the viewer's radio buttons", () => {
		const byName = new Map(upcoming()?.attendance.map((a) => [a.who.name, a]));
		const plans = new Set(upcoming()?.attendance.map((a) => a.plan));
		expect(plans).toEqual(new Set(["attending", "not_attending", "unknown"]));
		// The viewer's own row is radio buttons; "N" is checked.
		expect(byName.get("Avery Alderfinch")).toMatchObject({ plan: "not_attending", record: null });
		expect(upcoming()?.attendance.every((a) => a.record === null)).toBe(true);
	});

	it.each([
		["1", "attending"], // P
		["6", "attending"], // O: online
		["2", "not_attending"], // N
		["5", "unknown"], // ?
	])("reads the viewer's radio button %s as %s", (value, plan) => {
		const doc = fixtureDoc("meeting-upcoming.html");
		for (const r of Array.from(doc.querySelectorAll('input[name="available[900001]"]'))) {
			if (r.getAttribute("value") === value) r.setAttribute("checked", "");
			else r.removeAttribute("checked");
		}
		const m = parseMeeting(doc, "644360", TZ);
		expect(m?.attendance.find((x) => x.who.name === "Avery Alderfinch")?.plan).toBe(plan);
	});

	it("maps an Online reply to attending, since the contract has no online plan", () => {
		const html = readFixture("meeting-upcoming.html");
		expect(html).toContain("Online");
		const m = parseMeeting(parseHtml(html), "644360", TZ);
		const online = m?.guests.find((g) => g.category === "past_visitor");
		expect(online).toBeDefined();
		expect(m?.attendance.find((a) => a.who.name === online?.who.name)?.plan).toBe("attending");
	});

	it("keeps guests who replied, one per category, and drops guests who did not", () => {
		const m = upcoming();
		expect(m?.guests.map((g) => g.category).sort()).toEqual([
			"guest_speaker",
			"past_visitor",
			"visitor",
			"visitor_other_club",
		]);
		// Sixteen people are listed in the guest sections; only the four who replied are guests.
		expect(m?.attendance.length).toBeGreaterThan(m?.guests.length ?? 0);
	});

	it("keeps a guest-section person who holds a role, even with no reply and no recorded attendance", () => {
		const html = readFixture("meeting-upcoming.html");
		// Reese is listed under Guest Speaker with an Unknown reply: not a guest on her own.
		expect(upcoming()?.guests.map((g) => g.who.name)).not.toContain("Reese Thistledown");
		// Make Reese the Toastmaster (the role table's link; the attendance rows keep their own).
		const at = html.indexOf(">Toastmaster</a>");
		const held =
			html.slice(0, at) +
			html
				.slice(at)
				.replace("privmsg.php?mode=post&amp;u=900026')\">Zephyr Ashlowe", "privmsg.php?mode=post&amp;u=900018')\">Reese Thistledown");
		expect(held).not.toBe(html);
		const m = parseMeeting(parseHtml(held), "644360", TZ);
		expect(m?.roles.find((r) => r.role === "Toastmaster")?.holder).toEqual({ esUserId: "900018", name: "Reese Thistledown" });
		expect(m?.guests).toContainEqual({ who: { esUserId: "900018", name: "Reese Thistledown" }, category: "guest_speaker" });
		// Exactly one more guest than before, and the replied ones are all still there.
		expect(m?.guests).toHaveLength((upcoming()?.guests.length ?? 0) + 1);
	});

	it("reads a Tentative reply", () => {
		const html = readFixture("meeting-upcoming.html").replace(/(<img name="attend_image1\[\d+\]">)\s*Attending/, "$1 Tentative");
		const m = parseMeeting(parseHtml(html), "644360", TZ);
		expect(m?.attendance.some((a) => a.plan === "tentative")).toBe(true);
	});

	it("reads the Table Topics block with no speakers as []", () => {
		expect(upcoming()?.tableTopics).toEqual([]);
		expect(readFixture("meeting-upcoming.html")).toContain("No speakers added yet");
	});

	it("has no awards before the meeting happens", () => {
		expect(upcoming()?.awards).toEqual([]);
	});
});

describe("a past meeting with awards (t=644304)", () => {
	it("reads all 3 awards with their recipients", () => {
		expect(completed()?.awards.map((a) => a.category).sort()).toEqual([
			"best_evaluator",
			"best_speaker",
			"best_table_topics",
		]);
		expect(completed()?.awards.every((a) => a.who.esUserId?.startsWith("9"))).toBe(true);
	});

	it("reads recorded attendance, in person and online, in place of the plan", () => {
		const m = completed();
		expect(m?.attendance.every((a) => a.plan === null)).toBe(true);
		expect(m?.attendance.filter((a) => a.record === "attended")).not.toHaveLength(0);
		expect(m?.attendance.filter((a) => a.record === "attended_online")).toHaveLength(1);
		// "Did NOT Attend" is a row with nothing recorded.
		expect(m?.attendance.filter((a) => a.record === null)).toHaveLength(1);
		expect(m?.guests).toEqual([
			{ who: expect.objectContaining({ name: "Harper Pennywhistle" }), category: "past_visitor" },
		]);
	});

	it("reads 'No speakers added yet' as an empty Table Topics list", () => {
		expect(completed()?.tableTopics).toEqual([]);
		expect(readFixture("meeting-completed.html")).toContain("No speakers added yet");
	});

	it("reads the word of the day and a meeting with no online link", () => {
		expect(completed()).toMatchObject({ wordOfTheDay: "Maturity", joinUrl: null, theme: "Coming of Age" });
	});
});

describe("Table Topics speakers, populated (hand-built fixture)", () => {
	it("reads each speaker and their topic", () => {
		const m = parseMeeting(fixtureDoc("meeting-table-topics.html"), "644363", TZ);
		expect(m?.tableTopics).toEqual([
			{ who: { esUserId: "900011", name: "Kai Underhill" }, topic: "What is your favorite season?" },
			{ who: { esUserId: "900012", name: "Lane Cragwell" }, topic: null },
		]);
	});
});

describe("not a meeting", () => {
	it("returns null for a page with no dated title", () => {
		expect(parseMeeting(parseHtml("<html><body>Login</body></html>"), "1", TZ)).toBeNull();
	});
});

describe("speech list", () => {
	const rows = () => parseSpeechList(fixtureDoc("speech-list.html"));

	it("reads requested, scheduled and completed speeches with preferred dates", () => {
		const statuses = rows().map((r) => r.request.status);
		expect(new Set(statuses)).toEqual(new Set(["requested", "scheduled", "completed"]));
		const scheduled = rows().find((r) => r.request.status === "scheduled" && r.request.who.name !== "Avery Alderfinch");
		expect(scheduled?.request).toMatchObject({ scheduledOn: "2026-10-13", requestedOn: "2026-09-29", preferred: [null, null, null] });
		const preferred = rows().find((r) => r.request.preferred.some(Boolean));
		expect(preferred?.request).toMatchObject({ requestedOn: "2025-05-26", preferred: ["2025-06-03", null, null], status: "requested" });
		const completed = rows().find((r) => r.request.status === "completed");
		expect(completed?.request).toMatchObject({ requestedOn: null, preferred: [], scheduledOn: "2026-09-22" });
	});

	it("takes the speech id from the assignment link, and none for an undecided workbook", () => {
		const undecided = rows().find((r) => r.request.title === "Trying to build a Tiny House");
		expect(undecided?.request).toMatchObject({ esSpeechId: null, path: null, project: null });
		expect(rows().find((r) => r.request.esSpeechId === "1384322")?.request).toMatchObject({
			path: "Engaging Humor",
			project: "The Power of Humor in an Impromptu Speech - 2",
		});
	});

	it("offers a request form only for the viewer's own speeches", () => {
		const withForm = rows().filter((r) => r.requestFormPath);
		expect(withForm.map((r) => r.requestFormPath)).toEqual([
			"request_speech.php?mode=entertitle&s=1473688&u=900001",
			"request_speech.php?mode=entertitle&s=1473689&u=900001",
		]);
		expect(withForm.every((r) => r.request.who.esUserId === "900001")).toBe(true);
	});

	it("never holds an introduction: the list has none", () => {
		expect(rows().every((r) => r.request.introduction === null)).toBe(true);
	});
});

describe("request form", () => {
	it("reads the speech's id, title and introduction", () => {
		expect(parseRequestForm(fixtureDoc("speech-request-intro.html"))).toEqual({
			esSpeechId: "1473688",
			title: "Fixture Garden Tour",
			introduction:
				"Our next speaker grows tomatoes on a balcony. Please welcome a gardener with a fake story to tell.",
		});
	});

	it("reads a form with no introduction as null", () => {
		const html = readFixture("speech-request-intro.html")
			.replace(/Our next speaker grows tomatoes[^<"]*/g, "");
		expect(parseRequestForm(parseHtml(html)).introduction).toBeNull();
	});
});

describe("member charts", () => {
	it("reads mentors, and who wants a mentee", () => {
		const { mentors, joined } = parseMentoring(fixtureDoc("chart-8-mentors.html"));
		expect(mentors.filter((m) => m.mentor)).not.toHaveLength(0);
		expect(mentors.every((m) => m.mentor || m.wantsMentee)).toBe(true);
		expect(mentors.find((m) => m.wantsMentee)).toMatchObject({ mentor: null, wantsMentee: true });
		expect(joined.get("900026")).toBe("2020-10-31");
	});

	it("reads visitors introduced, one pair per visitor (hand-built fixture)", () => {
		expect(parseVisitorsIntroduced(fixtureDoc("chart-7-visitors-introduced.html"))).toEqual([
			{ visitor: { esUserId: "900031", name: "Elliot Lindenhurst" }, introducedBy: { esUserId: "900005", name: "Elliot Dovecott" } },
			{ visitor: { esUserId: "900032", name: "Frankie Saltmarsh" }, introducedBy: { esUserId: "900005", name: "Elliot Dovecott" } },
		]);
	});

	it("reads a bare count of visitors as no pairs", () => {
		const html = readFixture("chart-7-visitors-introduced.html").replace(/<a [^>]*class="gen">[^<]*<\/a>\s*,\s*<a [^>]*class="gen">[^<]*<\/a>/, "2");
		expect(parseVisitorsIntroduced(parseHtml(html))).toEqual([]);
	});
});

describe("evaluations", () => {
	const list = JSON.parse(readFixture("my-evaluations.json"));

	it("skips drafts", () => {
		expect(parseEvaluationList(list).map((e) => e.evaluation_id)).toEqual([501, 502]);
		expect(parseEvaluationList({})).toEqual([]);
		expect(parseEvaluationList(null)).toEqual([]);
	});

	it("names the exporter on their own side of a received and a given evaluation", () => {
		const [received, given] = parseEvaluationList(list);
		const got = parseEvaluation(received, JSON.parse(readFixture("evaluation-501.json")), "Avery Alderfinch");
		expect(got).toEqual({
			esId: "501",
			speaker: { esUserId: null, name: "Avery Alderfinch" },
			evaluator: { esUserId: null, name: expect.any(String) },
			date: "2026-09-22",
			text: "What went well: Clear structure and a confident close.\n\nWhat to improve: Slow down in the middle.",
		});
		const gave = parseEvaluation(given, JSON.parse(readFixture("evaluation-502.json")), "Avery Alderfinch");
		expect(gave.evaluator.name).toBe("Avery Alderfinch");
		expect(gave.speaker.name).not.toBe("Avery Alderfinch");
	});
});

describe("helpers", () => {
	it("strips credentials after the comma and nothing else", () => {
		expect(stripCredentials("Avery Alderfinch, DTM PDD")).toBe("Avery Alderfinch");
		expect(stripCredentials("Blair Hollowby, ACB ALB")).toBe("Blair Hollowby");
		expect(stripCredentials("Casey Oakenshaw-Vexford")).toBe("Casey Oakenshaw-Vexford");
		expect(stripCredentials("Guest -Fixture Speakers")).toBe("Guest -Fixture Speakers");
	});

	it("converts club-local time to an instant across daylight saving, and keeps local time with no zone", () => {
		expect(localToInstant(2026, 7, 14, 19, 0, TZ)).toBe("2026-07-15T02:00:00.000Z");
		expect(localToInstant(2026, 12, 15, 19, 0, TZ)).toBe("2026-12-16T03:00:00.000Z");
		// The Sunday the clocks go forward: 3:30 am exists, 2:30 am does not.
		expect(localToInstant(2026, 3, 8, 3, 30, TZ)).toBe("2026-03-08T10:30:00.000Z");
		expect(localToInstant(2026, 10, 13, 19, 0, null)).toBe("2026-10-13T19:00:00");
		expect(localToInstant(2026, 10, 13, 19, 0, "Not/AZone")).toBe("2026-10-13T19:00:00");
	});
});
