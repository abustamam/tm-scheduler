import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EasySpeakBundleV1 } from "./easy-speak-bundle";
import {
	buildImportPlan,
	ERASED_ACCOUNT_REASON,
	needsDecision,
	type PlanContext,
	type PlanRosterMember,
} from "./easy-speak-import-plan";

/**
 * One upload builds the roster and the history (#1240): what the plan decides
 * for a person the roster does not hold, and where pasted contacts land.
 * Pure: a bundle and a context in, a plan out.
 */
const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ADA: PlanRosterMember = { memberId: id(1), name: "Ada Linked" };
const SAM_A: PlanRosterMember = { memberId: id(2), name: "Sam Same" };
const SAM_B: PlanRosterMember = { memberId: id(3), name: "Sam Same" };

const ref = (esUserId: string, name: string) => ({ esUserId, name });

/** The fixture's one past meeting, rewritten to name exactly the people a test gives it. */
function bundleWith(over: {
	people?: EasySpeakBundleV1["people"];
	holders?: Array<{ role: string; who: { esUserId: string; name: string } }>;
	guests?: Array<{
		who: { esUserId: string; name: string };
		category: "visitor" | "guest_speaker";
	}>;
}): EasySpeakBundleV1 {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
	const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
	if (!past) throw new Error("fixture changed");
	bundle.meetings = [
		{
			...past,
			roles: (over.holders ?? []).map((h, i) => ({
				role: h.role,
				slot: i + 1,
				holder: h.who,
			})),
			attendance: [],
			guests: over.guests ?? [],
			awards: [],
			tableTopics: [],
		},
	];
	bundle.people = over.people ?? [];
	bundle.mentors = [];
	bundle.speechRequests = [];
	bundle.visitorsIntroduced = [];
	return bundle;
}

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
	now: NOW,
	clubTimezone: "America/Los_Angeles",
	roster: [ADA, SAM_A, SAM_B],
	roleDefinitions: [],
	guestIds: new Set(),
	existingMeetings: [],
	refs: [],
	...over,
});

/** The acceptance-criterion fixture: eight people, one of each source. */
function eightPeople(): EasySpeakBundleV1 {
	const p = (n: number) => `9001${String(n).padStart(2, "0")}`;
	return bundleWith({
		people: [
			{
				esUserId: p(1),
				name: "Pia President",
				status: "President",
				joined: "2020-01-02",
			},
			{ esUserId: p(2), name: "Mo Member", status: "Member", joined: null },
			{
				esUserId: p(3),
				name: "Ines Inactive",
				status: "Inactive Member",
				joined: "2019-05-06",
			},
		],
		holders: [
			{ role: "Timer", who: ref(p(4), "Tom Pastmeeting") },
			{ role: "Grammarian", who: ref(p(6), "Forgotten User") },
			{ role: "Toastmaster", who: ref(p(7), "Ada Linked") },
			{ role: "Ah-Counter", who: ref(p(8), "Sam Same") },
		],
		guests: [{ who: ref(p(5), "Gia Guest"), category: "visitor" }],
	});
}

const outcome = (plan: ReturnType<typeof buildImportPlan>, key: string) =>
	plan.people.find((p) => p.key === `es:${key}`)?.outcome;

describe("an unmatched person resolves by rule (#1240)", () => {
	// protects=each source of an unmatched person lands on the outcome the issue's
	// table gives it, and only the name two members share is left to a human;
	// fails_when=an on-the-list member becomes a guest or former, a past person a
	// guest, a guest-only name a member, or an erased account is asked about;
	// no_claim=the apply writes nothing here: the plan only. The fixture is a
	// handmade bundle on the extension's meeting, not a real Easy-Speak export.
	it("gives each source of person its outcome and asks only about the ambiguous one", () => {
		const plan = buildImportPlan(eightPeople(), ctx());
		expect(outcome(plan, "900101")).toEqual({
			status: "create",
			membership: "active",
			position: "president",
			joinedAt: "2020-01-02",
		});
		expect(outcome(plan, "900102")).toEqual({
			status: "create",
			membership: "active",
			position: null,
			joinedAt: null,
		});
		expect(outcome(plan, "900103")).toEqual({
			status: "create",
			membership: "former",
			position: null,
			joinedAt: "2019-05-06",
		});
		expect(outcome(plan, "900104")).toEqual({
			status: "create",
			membership: "former",
			position: null,
			joinedAt: null,
		});
		expect(outcome(plan, "900105")).toMatchObject({
			status: "guest",
			via: "category",
		});
		expect(outcome(plan, "900106")).toEqual({
			status: "skipped",
			reason: ERASED_ACCOUNT_REASON,
		});
		expect(outcome(plan, "900107")).toMatchObject({
			status: "member",
			memberId: ADA.memberId,
		});
		expect(outcome(plan, "900108")?.status).toBe("ambiguous");
		expect(plan.people.filter(needsDecision).map((p) => p.key)).toEqual([
			"es:900108",
		]);
		expect(plan.canApply).toBe(false);
		expect(plan.counts).toMatchObject({
			linkedMembers: 1,
			newActiveMembers: 2,
			newOfficers: 1,
			newFormerMembers: 2,
			newGuests: 1,
			erasedAccounts: 1,
		});
	});

	// protects=only the exact name "Forgotten User" (after case and spacing are
	// folded) is an erased account; a name that merely contains it is a person;
	// fails_when=a substring or prefix match skips a real person's history;
	// no_claim=none beyond protects.
	it("skips only the exact erased-account name, not a name that contains it", () => {
		const bundle = bundleWith({
			holders: [
				{ role: "Timer", who: ref("900201", "Forgotten Friend") },
				{ role: "Toastmaster", who: ref("900202", "  forgotten   USER ") },
				{ role: "Grammarian", who: ref("900203", "Forgotten User Jr") },
			],
		});
		const plan = buildImportPlan(bundle, ctx());
		expect(outcome(plan, "900201")?.status).toBe("create");
		expect(outcome(plan, "900202")).toMatchObject({ status: "skipped" });
		expect(outcome(plan, "900203")?.status).toBe("create");
	});

	// protects=an erased account is skipped BEFORE name matching, so a roster
	// member who happens to be named that is never linked to an erased account;
	// fails_when=the roster match runs first and links the erased account;
	// no_claim=none beyond protects.
	it("skips an erased account before it can match the roster", () => {
		const plan = buildImportPlan(
			bundleWith({
				holders: [{ role: "Timer", who: ref("900301", "Forgotten User") }],
			}),
			ctx({ roster: [{ memberId: id(9), name: "Forgotten User" }] }),
		);
		expect(outcome(plan, "900301")).toMatchObject({ status: "skipped" });
	});

	// protects=a saved answer wins over the rules, including the erased-account
	// skip and an automatic member creation (precedence 1);
	// fails_when=the answer is ignored for a person the rules already placed;
	// no_claim=a saved answer for a deleted-guest tombstone is covered by the
	// older plan tests; this covers create and skipped only.
	it("lets a saved answer win over the rule", () => {
		const plan = buildImportPlan(
			eightPeople(),
			ctx({
				resolutions: {
					"es:900106": { action: "guest", kind: "visitor" },
					"es:900102": { action: "skip", reason: "Not ours" },
				},
			}),
		);
		expect(outcome(plan, "900106")).toMatchObject({
			status: "guest",
			via: "chosen",
		});
		expect(outcome(plan, "900102")).toEqual({
			status: "skipped",
			reason: "Not ours",
		});
	});

	// protects=a person an earlier apply made is resolved through their `person`
	// import ref, so a re-apply creates nobody even when the roster name changed;
	// fails_when=the plan re-derives "create" for a person whose ref is live;
	// no_claim=the apply's own idempotence is the integration test's.
	it("resolves through an existing person ref before it would create anyone", () => {
		const plan = buildImportPlan(
			eightPeople(),
			ctx({
				roster: [ADA, SAM_A, SAM_B, { memberId: id(7), name: "Renamed Mo" }],
				refs: [{ kind: "person", sourceId: "es:900102", targetId: id(7) }],
			}),
		);
		expect(outcome(plan, "900102")).toEqual({
			status: "member",
			memberId: id(7),
			via: "ref",
		});
		expect(plan.counts.newActiveMembers).toBe(1);
	});

	// protects=an office text gives the position and an admin role only for an
	// ACTIVE listed member; "Inactive Member" never carries one, and a status that
	// is no office is an active member with none;
	// fails_when=an IT-support status becomes an officer, or a lapsed member keeps
	// an office;
	// no_claim=the office parser's own cases are officers.test.ts's.
	it("maps the status text to membership and office", () => {
		const bundle = bundleWith({
			people: [
				{
					esUserId: "900401",
					name: "Vee Pee",
					status: "Vice President of Education",
					joined: null,
				},
				{
					esUserId: "900402",
					name: "Ivy Tee",
					status: "IT Support - Co Admin",
					joined: null,
				},
				{
					esUserId: "900403",
					name: "Lapsed Pres",
					status: "inactive member",
					joined: null,
				},
			],
		});
		const plan = buildImportPlan(bundle, ctx());
		expect(outcome(plan, "900401")).toMatchObject({
			membership: "active",
			position: "vp_education",
		});
		expect(outcome(plan, "900402")).toMatchObject({
			membership: "active",
			position: null,
		});
		expect(outcome(plan, "900403")).toMatchObject({
			membership: "former",
			position: null,
		});
	});
});

describe("pasted contacts (#1240)", () => {
	const holders = (...names: string[]) =>
		names.map((n, i) => ({
			role: "Timer",
			who: ref(`9005${String(i).padStart(2, "0")}`, n),
		}));
	const withState = (
		contacts: string,
		memberState: Array<[string, string | null, string | null]> = [],
		emailHolders: Array<[string, string[]]> = [],
	) =>
		ctx({
			contacts,
			contactState: {
				members: new Map(
					memberState.map(([memberId, email, phone]) => [
						memberId,
						{ personId: `person-of-${memberId}`, email, phone },
					]),
				),
				emailHolders: new Map(
					emailHolders.map(([e, ids]) => [e, new Set(ids)]),
				),
			},
		});

	// protects=a row fills a blank email and phone on a created person, and on a
	// linked member only where blank; an existing value is never overwritten;
	// fails_when=a linked member's email is replaced, or a created person gets
	// nothing;
	// no_claim=the write itself (SQL guard) is the integration test's.
	it("fills only where blank, for a created and a linked person", () => {
		const bundle = bundleWith({
			holders: holders("New Person", "Ada Linked"),
		});
		const plan = buildImportPlan(
			bundle,
			withState(
				"New Person, new@example.com, 555-0100\nAda Linked, ada@example.com, 555-0199",
				[[ADA.memberId, "ada@old.example", null]],
			),
		);
		const byName = new Map(plan.contactFills.map((f) => [f.name, f]));
		expect(byName.get("New Person")).toMatchObject({
			email: "new@example.com",
			phone: "555-0100",
		});
		// Ada keeps her email; her blank phone is filled.
		expect(byName.get("Ada Linked")).toMatchObject({
			email: null,
			phone: "555-0199",
		});
		expect(plan.contactWarnings).toEqual([]);
	});

	// protects=a row that matches nobody, or two people, is warned about and
	// applied to no one, with the row number and no value;
	// fails_when=an unmatched row lands on someone, or the warning prints the email;
	// no_claim=none beyond protects.
	it("warns about a row that matches no one or two people, applying it to no one", () => {
		const bundle = bundleWith({ holders: holders("Ada Linked") });
		const plan = buildImportPlan(
			bundle,
			withState(
				"Nobody Known, nobody@example.com, 1\nSam Same, sam@example.com, 2",
			),
		);
		expect(plan.contactFills).toEqual([]);
		expect(plan.contactWarnings).toHaveLength(2);
		expect(plan.contactWarnings[0]).toContain("row 1");
		expect(plan.contactWarnings[1]).toContain("row 2");
		expect(plan.contactWarnings.join("\n")).not.toMatch(/@example/u);
	});

	// protects=the first of two rows for one person is used and the later one is
	// warned about; the same email on two different people's rows goes to neither;
	// fails_when=the last row wins, or one of two people keeps a shared email;
	// no_claim=none beyond protects.
	it("uses the first row per person and gives a shared email to neither", () => {
		const bundle = bundleWith({
			holders: holders("Ann One", "Bob Two", "Cy Three"),
		});
		const plan = buildImportPlan(
			bundle,
			withState(
				[
					"Ann One, first@example.com, ",
					"Ann One, second@example.com, ",
					"Bob Two, shared@example.com, ",
					"Cy Three, SHARED@example.com, ",
				].join("\n"),
			),
		);
		const ann = plan.contactFills.find((f) => f.name === "Ann One");
		expect(ann?.email).toBe("first@example.com");
		expect(plan.contactFills.find((f) => f.name === "Bob Two")).toBeUndefined();
		expect(
			plan.contactFills.find((f) => f.name === "Cy Three"),
		).toBeUndefined();
		const warnings = plan.contactWarnings.join("\n");
		expect(warnings).toContain("row 2");
		expect(warnings).toMatch(/row 3[^\n]*Bob Two/u);
		expect(warnings).toMatch(/row 4[^\n]*Cy Three/u);
		expect(warnings).not.toMatch(/@example/u);
	});

	// protects=an email another Person (any club) already holds is not set, and
	// the warning names the row and the person, never the email; the person's OWN
	// email is not "someone else's";
	// fails_when=the email is set anyway, or a linked member is refused their own;
	// no_claim=the lookup that fills `emailHolders` is the integration test's.
	it("refuses an email another person holds and names the row", () => {
		const bundle = bundleWith({ holders: holders("New Person", "Ada Linked") });
		const plan = buildImportPlan(
			bundle,
			withState(
				"New Person, taken@example.com, 555-0100\nAda Linked, ada@example.com, ",
				[[ADA.memberId, null, null]],
				[
					["taken@example.com", ["someone-else"]],
					["ada@example.com", [`person-of-${ADA.memberId}`]],
				],
			),
		);
		const fillFor = (n: string) => plan.contactFills.find((f) => f.name === n);
		expect(fillFor("New Person")).toMatchObject({
			email: null,
			phone: "555-0100",
		});
		expect(fillFor("Ada Linked")?.email).toBe("ada@example.com");
		expect(plan.contactWarnings).toEqual([
			"An email in row 1 already belongs to someone else; left blank for New Person.",
		]);
	});

	// protects=no contacts means no fills and no warnings;
	// fails_when=an empty box produces a warning per person;
	// no_claim=none beyond protects.
	it("does nothing without contacts", () => {
		const plan = buildImportPlan(eightPeople(), ctx());
		expect(plan.contactFills).toEqual([]);
		expect(plan.contactWarnings).toEqual([]);
	});
});
