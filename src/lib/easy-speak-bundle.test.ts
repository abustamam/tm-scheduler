import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type EasySpeakBundleV1,
	easySpeakBundleV1Schema,
	isContactPageUrl,
} from "./easy-speak-bundle";

/**
 * The contract's two copies (#1047): the zod schema here, and the plain
 * TypeScript shape in `extension/lib/easy-speak-bundle.ts`. The extension's
 * walk test PRODUCES this file from the committed fixtures; this test
 * parses it with the schema, so a change to either side that the other does
 * not follow fails here.
 *
 * Nothing under `src/` imports from `extension/`: the extension's tsconfig
 * extends the generated, gitignored `.wxt/tsconfig.json`, which the root CI
 * job never creates, so Vite cannot transform an extension .ts file there.
 * The two sides meet through JSON fixtures and plain text reads only.
 */
const FIXTURES = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak",
);
const EXPECTED = resolve(FIXTURES, "bundle.expected.json");

const read = (name: string): string =>
	readFileSync(resolve(FIXTURES, name), "utf8");

const load = (): EasySpeakBundleV1 =>
	JSON.parse(readFileSync(EXPECTED, "utf8"));

const CONTACT_CASES: { url: string; expected: boolean }[] = JSON.parse(
	read("contact-page-cases.json"),
).cases;

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
		expect(b.raw.some((r) => isContactPageUrl(r.url))).toBe(false);
	});

	it.each([
		"https://easy-speak.org/memberlist.php",
		"https://easy-speak.org/clubdata.php",
		"https://easy-speak.org/clubdata.php?tab=officers",
		"https://easy-speak.org/memberlist.php#page2",
		"memberlist.php",
		"https://easy-speak.org/MemberList.php",
	])("rejects a raw page whose url is the contact page %s", (url) => {
		const b = load();
		const bad = { ...b, raw: [...b.raw, { ...b.raw[0], url }] };
		const parsed = easySpeakBundleV1Schema.safeParse(bad);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.path).toEqual(["raw", b.raw.length, "url"]);
	});

	it.each(
		CONTACT_CASES.map((c) => [c.url, c.expected] as const),
	)("isContactPageUrl(%j) is %s, the case table the extension's isContactPage also answers", (url, expected) => {
		expect(isContactPageUrl(url)).toBe(expected);
	});

	it("the case table has both answers and the edges the rule cares about", () => {
		expect(CONTACT_CASES.some((c) => c.expected)).toBe(true);
		expect(CONTACT_CASES.some((c) => !c.expected)).toBe(true);
		expect(CONTACT_CASES.length).toBeGreaterThanOrEqual(15);
	});

	it("the extension's isContactPage and this isContactPageUrl are the same regex, read as text", () => {
		const regexOf = (file: string): string => {
			const text = readFileSync(resolve(__dirname, file), "utf8");
			const m = text.match(/return (\/.*\/i)\.test\(url\);/);
			expect(m, `${file}: the contact-page regex literal`).not.toBeNull();
			return (m as RegExpMatchArray)[1];
		};
		expect(regexOf("../../extension/lib/easy-speak-bundle.ts")).toBe(
			regexOf("./easy-speak-bundle.ts"),
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
