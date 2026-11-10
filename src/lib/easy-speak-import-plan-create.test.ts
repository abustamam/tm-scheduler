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
		memberState: Array<[string, string | null, string | null, boolean?]> = [],
		emailHolders: Array<[string, string[]]> = [],
	) =>
		ctx({
			contacts,
			contactState: {
				members: new Map(
					memberState.map(([memberId, email, phone, emailWritable = true]) => [
						memberId,
						{
							personId: `person-of-${memberId}`,
							email,
							phone,
							emailWritable,
						},
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

	// protects=an email another Person already holds in THIS club (the holder set
	// is club-scoped by the lookup) is not set, and the warning names the row and
	// the person, never the email; the person's OWN email is not "someone else's";
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
			"An email in row 1 is already on another member of this club; left blank for New Person.",
		]);
	});

	// protects=R1's wording: with several holders in the club the warning is the one
	// neutral sentence per row, with no holder count, no other club and no hint of
	// whether anyone has signed in;
	// fails_when=the sentence gains a count, a club name or an account hint;
	// no_claim=which Persons are holders (loadContactState's integration test).
	it("words the holder warning neutrally however many holders there are", () => {
		const bundle = bundleWith({ holders: holders("New Person") });
		const plan = buildImportPlan(
			bundle,
			withState(
				"New Person, taken@example.com, ",
				[],
				[["taken@example.com", ["holder-one", "holder-two", "holder-three"]]],
			),
		);
		expect(plan.contactWarnings).toEqual([
			"An email in row 1 is already on another member of this club; left blank for New Person.",
		]);
		expect(plan.contactWarnings.join(" ")).not.toMatch(
			/\d{2,}|three|3 |account|signed|another club/iu,
		);
	});

	// protects=the preview promises an email fill only where the apply's UPDATE
	// would perform it (#907: nobody signed in as the Person, this club the sole
	// holder); a phone is unaffected;
	// fails_when=a linked member whose Person is signed in or in another club is
	// planned an email fill the apply then skips;
	// no_claim=`emailWritable` itself is computed by the SQL in loadContactState
	// (the integration test); here it is injected.
	it("plans no email fill for a linked member whose email is not writable, and says why", () => {
		const bundle = bundleWith({ holders: holders("Ada Linked") });
		const plan = buildImportPlan(
			bundle,
			withState("Ada Linked, ada@example.com, 555-0199", [
				[ADA.memberId, null, null, false],
			]),
		);
		expect(plan.contactFills).toHaveLength(1);
		expect(plan.contactFills[0]).toMatchObject({
			email: null,
			phone: "555-0199",
		});
		expect(plan.contactWarnings).toEqual([
			"The email in row 1 was left blank for Ada Linked: the person has a GavelUp account or belongs to another club, so it is theirs to add.",
		]);
	});

	// protects=a sole-holder unbound member with a blank email still gets the fill;
	// fails_when=the writable check refuses every linked member;
	// no_claim=the same injected state as above.
	it("plans the email fill for a linked member whose email is writable", () => {
		const bundle = bundleWith({ holders: holders("Ada Linked") });
		const plan = buildImportPlan(
			bundle,
			withState("Ada Linked, ada@example.com, ", [
				[ADA.memberId, null, null, true],
			]),
		);
		expect(plan.contactFills[0]?.email).toBe("ada@example.com");
		expect(plan.contactWarnings).toEqual([]);
	});

	// protects=a member who already holds an email gets no "theirs to add" note
	// (they keep what they have, silently, as before);
	// fails_when=the new warning fires for a member with an existing email;
	// no_claim=none beyond protects.
	it("does not warn about an unwritable email for a member who already has one", () => {
		const bundle = bundleWith({ holders: holders("Ada Linked") });
		const plan = buildImportPlan(
			bundle,
			withState("Ada Linked, ada@example.com, ", [
				[ADA.memberId, "ada@old.example", null, false],
			]),
		);
		expect(plan.contactWarnings).toEqual([]);
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

describe("likely-duplicate suggestions on a new member (#1589)", () => {
	const TISHIANA: PlanRosterMember = {
		memberId: id(11),
		name: "Tishiana Roe-Smith",
	};
	const TISH_KEY = "es:900201";
	const tish = () =>
		bundleWith({
			holders: [{ role: "Timer", who: ref("900201", "Tish Roe") }],
		});
	const tishOf = (plan: ReturnType<typeof buildImportPlan>) =>
		plan.people.find((p) => p.key === TISH_KEY);

	// protects=a new member whose name is likely a roster member's carries that member as a suggestion, stays a create and blocks nothing;
	// fails_when=the suggestion is missing, turns the person into a question, or holds Apply back;
	// no_claim=the panel's rendering; a handmade bundle stands in for an export.
	it("suggests the likely member, keeps the create and does not block", () => {
		const plan = buildImportPlan(tish(), ctx({ roster: [ADA, TISHIANA] }));
		const p = tishOf(plan);
		expect(p?.outcome.status).toBe("create");
		expect(p?.suggestions).toEqual([TISHIANA]);
		expect(p && needsDecision(p)).toBe(false);
		expect(plan.canApply).toBe(true);
		expect(plan.unresolved).toEqual([]);
	});

	// protects=at most three suggestions, in name order;
	// fails_when=a fourth likely member is listed, or the order is the roster's;
	// no_claim=which three when more than three tie beyond name order.
	it("caps the suggestions at three, by name", () => {
		const roster = [
			{ memberId: id(24), name: "Tina Roe" },
			{ memberId: id(21), name: "Tara Roe" },
			{ memberId: id(23), name: "Tess Roe" },
			{ memberId: id(22), name: "Tanya Roe" },
		];
		const plan = buildImportPlan(tish(), ctx({ roster }));
		expect(tishOf(plan)?.suggestions.map((m) => m.name)).toEqual([
			"Tanya Roe",
			"Tara Roe",
			"Tess Roe",
		]);
	});

	// protects=a person linked to a member gets no suggestions;
	// fails_when=a linked person lists a likely member;
	// no_claim=none beyond protects.
	it("gives no suggestions to a linked member", () => {
		const bundle = bundleWith({
			holders: [{ role: "Timer", who: ref("900202", "Tishiana Roe-Smith") }],
		});
		const roster = [TISHIANA, { memberId: id(12), name: "Tish Roe-Smith" }];
		const plan = buildImportPlan(bundle, ctx({ roster }));
		const p = plan.people.find((x) => x.key === "es:900202");
		expect(p?.outcome).toMatchObject({ status: "member", via: "exact" });
		expect(p?.suggestions).toEqual([]);
	});

	// protects=a guest gets no suggestions, even with a likely member on the roster;
	// fails_when=a guest lists a likely member;
	// no_claim=a "Same person as" picker for guests (out of scope).
	it("gives no suggestions to a guest", () => {
		const bundle = bundleWith({
			guests: [{ who: ref("900203", "Tish Roe"), category: "visitor" }],
		});
		const plan = buildImportPlan(bundle, ctx({ roster: [TISHIANA] }));
		const p = plan.people.find((x) => x.key === "es:900203");
		expect(p?.outcome.status).toBe("guest");
		expect(p?.suggestions).toEqual([]);
	});
});

describe('a saved "create" over an automatic link (#1589)', () => {
	const LINKED_KEY = "es:900301";
	const linkedBundle = (name: string, listed = true) =>
		bundleWith({
			people: listed
				? [
						{
							esUserId: "900301",
							name,
							status: "Vice President Education",
							joined: "2024-03-04",
						},
					]
				: [],
			holders: [{ role: "Timer", who: ref("900301", name) }],
		});
	const create = { [LINKED_KEY]: { action: "create" as const } };
	const SET_ASIDE = (name: string) =>
		`${name}: the saved answer "create" is set aside; they are matched automatically.`;
	const of = (plan: ReturnType<typeof buildImportPlan>) =>
		plan.people.find((p) => p.key === LINKED_KEY);

	// protects=a saved create over a same-name link makes a new member from the member-list row;
	// fails_when=the link stays, or the create ignores the row's membership, office or joined date;
	// no_claim=the apply's write (the integration test's).
	it("makes a new member over an exact-name link, from the member-list row", () => {
		const auto = buildImportPlan(linkedBundle("Ada Linked"), ctx());
		expect(of(auto)?.outcome).toMatchObject({ status: "member", via: "exact" });
		const plan = buildImportPlan(
			linkedBundle("Ada Linked"),
			ctx({ resolutions: create }),
		);
		expect(of(plan)?.outcome).toEqual({
			status: "create",
			membership: "active",
			position: "vp_education",
			joinedAt: "2024-03-04",
		});
		expect(plan.notes).not.toContain(SET_ASIDE("Ada Linked"));
	});

	// protects=a saved create over a folded-name link with no member-list row makes a former member;
	// fails_when=the link stays, or the create is made active;
	// no_claim=none beyond protects.
	it("makes a former member over a folded-name link with no list row", () => {
		const bundle = linkedBundle("ADA  linked", false);
		const auto = buildImportPlan(bundle, ctx());
		expect(of(auto)?.outcome).toMatchObject({
			status: "member",
			via: "folded",
		});
		const plan = buildImportPlan(bundle, ctx({ resolutions: create }));
		expect(of(plan)?.outcome).toEqual({
			status: "create",
			membership: "former",
			position: null,
			joinedAt: null,
		});
	});

	// protects=a saved create over an email link makes a new member;
	// fails_when=the email link stays;
	// no_claim=the contact fill's destination; contactState stands in for the people table.
	it("makes a new member over an email link", () => {
		const bundle = linkedBundle("Ada Elsewhere");
		const withEmail = (over: Partial<PlanContext> = {}) =>
			ctx({
				contacts: "Ada Elsewhere, ada@example.test, ",
				contactState: {
					members: new Map([
						[
							ADA.memberId,
							{
								personId: "person-ada",
								email: "ada@example.test",
								phone: null,
								emailWritable: true,
							},
						],
					]),
					emailHolders: new Map([
						["ada@example.test", new Set(["person-ada"])],
					]),
				},
				...over,
			});
		const auto = buildImportPlan(bundle, withEmail());
		expect(of(auto)?.outcome).toMatchObject({ status: "member", via: "email" });
		const plan = buildImportPlan(bundle, withEmail({ resolutions: create }));
		expect(of(plan)?.outcome).toMatchObject({
			status: "create",
			membership: "active",
		});
	});

	// protects=an earlier import's link is never re-pointed by a saved create, and a list-only person is never created;
	// fails_when=either becomes a create, or the set-aside note is missing;
	// no_claim=merging members, the way to fix an earlier import's link.
	it("sets the answer aside over an earlier import's ref and for a list-only person", () => {
		const refPlan = buildImportPlan(
			linkedBundle("Ada Linked"),
			ctx({
				resolutions: create,
				refs: [
					{ kind: "person", sourceId: LINKED_KEY, targetId: ADA.memberId },
				],
			}),
		);
		expect(of(refPlan)?.outcome).toEqual({
			status: "member",
			memberId: ADA.memberId,
			via: "ref",
		});
		expect(refPlan.notes).toContain(SET_ASIDE("Ada Linked"));

		const listOnly = bundleWith({
			people: [
				{
					esUserId: "900301",
					name: "Ada Linked",
					status: "Member",
					joined: null,
				},
			],
		});
		const listPlan = buildImportPlan(listOnly, ctx({ resolutions: create }));
		expect(of(listPlan)?.listOnly).toBe(true);
		expect(of(listPlan)?.outcome).toMatchObject({
			status: "member",
			memberId: ADA.memberId,
			via: "exact",
		});
		expect(listPlan.notes).toContain(SET_ASIDE("Ada Linked"));
	});
});

describe("the codex review round on #1591", () => {
	const ADA_ES = { esUserId: "900401", name: "Ada Linked" };
	/** An es: person and a meeting's name-only mention of the same name. */
	const withMention = () => {
		const bundle = bundleWith({ holders: [{ role: "Timer", who: ADA_ES }] });
		const meeting = bundle.meetings[0];
		if (!meeting) throw new Error("fixture changed");
		meeting.roles.push({
			role: "Grammarian",
			slot: 2,
			holder: { esUserId: null, name: "Ada Linked" },
		});
		return bundle;
	};

	// protects=a saved create on a name-only mention linked by name survives the namesake pass;
	// fails_when=the namesake pass links the mention back to the member it was told is someone else;
	// no_claim=the apply's write.
	it("keeps a create answer on a name-only mention", () => {
		const auto = buildImportPlan(withMention(), ctx({ roster: [ADA] }));
		expect(
			auto.people.find((p) => p.key === "name:ada linked")?.outcome,
		).toMatchObject({ status: "member", memberId: ADA.memberId });
		const plan = buildImportPlan(
			withMention(),
			ctx({
				roster: [ADA],
				resolutions: { "name:ada linked": { action: "create" } },
			}),
		);
		expect(
			plan.people.find((p) => p.key === "name:ada linked")?.outcome.status,
		).toBe("create");
		expect(
			plan.people.find((p) => p.key === "es:900401")?.outcome,
		).toMatchObject({
			status: "member",
			memberId: ADA.memberId,
		});
		expect(plan.canApply).toBe(true);
	});

	// protects=createAllowed says where a create answer takes effect: a create or a name link yes, an ambiguous match or an earlier import's ref no;
	// fails_when=the panel would offer New member to a person the planner then leaves ambiguous, or hide it from a name link;
	// no_claim=the panel's reading of it (component test).
	it("says where a create answer would take effect", () => {
		const two = buildImportPlan(
			bundleWith({
				holders: [{ role: "Timer", who: ref("900402", "Sam Same") }],
			}),
			ctx({
				resolutions: {
					"es:900402": { action: "member", memberId: SAM_A.memberId },
				},
			}),
		);
		const sam = two.people.find((p) => p.key === "es:900402");
		expect(sam?.outcome).toMatchObject({ status: "member", via: "chosen" });
		expect(sam?.createAllowed).toBe(false);

		const linked = buildImportPlan(
			bundleWith({ holders: [{ role: "Timer", who: ADA_ES }] }),
			ctx(),
		);
		expect(
			linked.people.find((p) => p.key === "es:900401")?.createAllowed,
		).toBe(true);
		const byRef = buildImportPlan(
			bundleWith({ holders: [{ role: "Timer", who: ADA_ES }] }),
			ctx({
				refs: [
					{ kind: "person", sourceId: "es:900401", targetId: ADA.memberId },
				],
			}),
		);
		expect(byRef.people.find((p) => p.key === "es:900401")?.createAllowed).toBe(
			false,
		);
		const fresh = buildImportPlan(
			bundleWith({
				holders: [{ role: "Timer", who: ref("900403", "Nia New") }],
			}),
			ctx(),
		);
		expect(fresh.people.find((p) => p.key === "es:900403")?.createAllowed).toBe(
			true,
		);
	});
});
