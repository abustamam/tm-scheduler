// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseClubData,
	parseMeeting,
	parseMemberList,
	parseSpeechList,
} from "../../extension/lib/easy-speak-parse";
import {
	type EasySpeakBundleV1,
	easySpeakBundleV1Schema,
} from "./easy-speak-bundle";

/**
 * The contract's two copies (#1047): the zod schema here, and the plain
 * TypeScript shape in `extension/lib/easy-speak-bundle.ts`. The extension's
 * parser tests PRODUCE this file from the committed fixtures; this test
 * parses it with the schema, so a change to either side that the other does
 * not follow fails here.
 */
const FIXTURES = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak",
);
const EXPECTED = resolve(FIXTURES, "bundle.expected.json");

const load = (): EasySpeakBundleV1 =>
	JSON.parse(readFileSync(EXPECTED, "utf8"));

describe("easySpeakBundleV1Schema", () => {
	it("accepts the bundle the extension's parsers produce from the fixtures", () => {
		const parsed = easySpeakBundleV1Schema.safeParse(load());
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.success).toBe(true);
	});

	it("round-trips the bundle unchanged: the schema drops and adds nothing", () => {
		const bundle = load();
		expect(easySpeakBundleV1Schema.parse(bundle)).toEqual(bundle);
	});

	it("covers each section the issue lists", () => {
		const b = easySpeakBundleV1Schema.parse(load());
		expect(b.meetings.length).toBeGreaterThan(0);
		expect(b.meetings.some((m) => m.awards.length === 3)).toBe(true);
		expect(
			b.meetings.some((m) => m.roles.some((r) => r.evaluates !== undefined)),
		).toBe(true);
		expect(
			b.meetings.flatMap((m) => m.guests.map((g) => g.category)).sort(),
		).toEqual([
			"guest_speaker",
			"past_visitor",
			"past_visitor",
			"visitor",
			"visitor_other_club",
		]);
		expect(b.meetings.some((m) => m.tableTopics.length > 0)).toBe(true);
		expect(b.speechRequests.length).toBeGreaterThan(0);
		expect(b.mentors.length).toBeGreaterThan(0);
		expect(b.visitorsIntroduced.length).toBeGreaterThan(0);
		expect(b.evaluations.length).toBeGreaterThan(0);
		expect(b.people.length).toBeGreaterThan(0);
	});

	it("never carries memberlist.php or clubdata.php in raw", () => {
		const b = easySpeakBundleV1Schema.parse(load());
		expect(b.raw.some((r) => /\/(memberlist|clubdata)\.php/.test(r.url))).toBe(
			false,
		);
	});

	it("accepts a bundle with every list empty (a member export can be nearly empty)", () => {
		const b = load();
		const empty = {
			...b,
			people: [],
			meetings: [],
			speechRequests: [],
			mentors: [],
			visitorsIntroduced: [],
			evaluations: [],
			raw: [],
		};
		expect(easySpeakBundleV1Schema.safeParse(empty).success).toBe(true);
	});

	it.each([
		[
			"another format",
			(b: EasySpeakBundleV1) => ({ ...b, format: "gavelup.other" }),
		],
		["another version", (b: EasySpeakBundleV1) => ({ ...b, version: 2 })],
		["no club", (b: EasySpeakBundleV1) => ({ ...b, club: undefined })],
		[
			"a meeting time that is not a time",
			(b: EasySpeakBundleV1) => ({
				...b,
				meetings: [{ ...b.meetings[0], startsAt: "next Tuesday" }],
			}),
		],
		[
			"an attendance plan the contract does not have",
			(b: EasySpeakBundleV1) => ({
				...b,
				meetings: [
					{
						...b.meetings[1],
						attendance: [{ ...b.meetings[1].attendance[0], plan: "online" }],
					},
				],
			}),
		],
		[
			"an award category the contract does not have",
			(b: EasySpeakBundleV1) => ({
				...b,
				meetings: [
					{
						...b.meetings[0],
						awards: [
							{ category: "best_joke", who: { esUserId: "1", name: "x" } },
						],
					},
				],
			}),
		],
		[
			"a guest category the contract does not have",
			(b: EasySpeakBundleV1) => ({
				...b,
				meetings: [
					{
						...b.meetings[1],
						guests: [{ who: { esUserId: "1", name: "x" }, category: "member" }],
					},
				],
			}),
		],
		[
			"a person with no name",
			(b: EasySpeakBundleV1) => ({
				...b,
				people: [{ ...b.people[0], name: undefined }],
			}),
		],
		[
			"a slot of zero",
			(b: EasySpeakBundleV1) => ({
				...b,
				meetings: [
					{ ...b.meetings[1], roles: [{ ...b.meetings[1].roles[0], slot: 0 }] },
				],
			}),
		],
		[
			"a joined date that is not a date",
			(b: EasySpeakBundleV1) => ({
				...b,
				people: [{ ...b.people[0], joined: "May 2025" }],
			}),
		],
	])("rejects %s", (_name, mutate) => {
		expect(easySpeakBundleV1Schema.safeParse(mutate(load())).success).toBe(
			false,
		);
	});
});

/**
 * The extension's own tests parse the fixtures with linkedom. Here the same
 * parsers read them with jsdom (a spec-compliant parser, like the browser's
 * DOMParser the content script uses), and must give the bundle's own sections.
 * Easy-Speak's markup is old and malformed; this is the check that the parsers
 * do not lean on one DOM implementation's habits.
 */
describe("the extension's parsers under a spec-compliant DOM", () => {
	const doc = (name: string) =>
		new DOMParser().parseFromString(
			readFileSync(resolve(FIXTURES, name), "utf8"),
			"text/html",
		);
	const expected = load();
	const TZ = expected.club.timezone;

	it("read the club, the member list and the speech list as the bundle has them", () => {
		expect(parseClubData(doc("club-data.html"))).toEqual({
			number: expected.club.number,
			name: expected.club.name,
			timezone: TZ,
		});
		expect(parseMemberList(doc("member-list.html")).people).toEqual(
			expected.people.map(({ joined: _joined, ...p }) => p),
		);
		const requests = (rs: typeof expected.speechRequests) =>
			rs.map(
				({
					esSpeechId,
					who,
					path,
					project,
					requestedOn,
					preferred,
					scheduledOn,
					status,
				}) => ({
					esSpeechId,
					who,
					path,
					project,
					requestedOn,
					preferred,
					scheduledOn,
					status,
				}),
			);
		expect(
			requests(parseSpeechList(doc("speech-list.html")).map((r) => r.request)),
		).toEqual(requests(expected.speechRequests));
	});

	it.each([
		["644360", "meeting-upcoming.html"],
		["644304", "meeting-completed.html"],
		["644363", "meeting-table-topics.html"],
	])("read meeting %s as the bundle has it", (id, file) => {
		const want = expected.meetings.find((m) => m.esMeetingId === id);
		// The bundle links an agenda speech to its speech-list row (id, introduction);
		// a single page cannot.
		const unlinked = {
			...want,
			roles: want?.roles.map((r) =>
				r.speech
					? {
							...r,
							speech: { ...r.speech, esSpeechId: null, introduction: null },
						}
					: r,
			),
		};
		expect(parseMeeting(doc(file), id, TZ)).toEqual(unlinked);
	});
});
