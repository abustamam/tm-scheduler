import { describe, expect, it } from "vitest";
import {
	assigneeDisplayName,
	buildPickerRows,
	buildRoleCounts,
	buildRosterEntries,
	buildShortCodes,
	formatLastServed,
	generateSlotRows,
	OPEN_LABEL,
	resolveAssignAction,
	resolveEvaluatorLinks,
	roleAbbrev,
	rosterGridPositions,
	slotAccessibleLabel,
	slotLabel,
	summarizeAgenda,
} from "./agenda";

const rosterSlot = (
	roleName: string,
	slotIndex: number,
	category: "leadership" | "speaker" | "evaluator" | "functionary",
	isSpeakerRole = false,
	assigneeName: string | null = null,
) => ({ roleName, slotIndex, category, isSpeakerRole, assigneeName });

describe("buildRosterEntries", () => {
	it("interleaves speakers with their paired evaluators so each pair shares a row", () => {
		const slots = [
			rosterSlot("Toastmaster of the Day", 0, "leadership"),
			rosterSlot("Table Topics Master", 0, "leadership"),
			rosterSlot("Speaker", 0, "speaker", true),
			rosterSlot("Speaker", 1, "speaker", true),
			rosterSlot("Speaker", 2, "speaker", true),
			rosterSlot("Evaluator", 0, "evaluator"),
			rosterSlot("Evaluator", 1, "evaluator"),
			rosterSlot("Evaluator", 2, "evaluator"),
			rosterSlot("General Evaluator", 0, "evaluator"),
			rosterSlot("Timer", 0, "functionary"),
		];
		expect(buildRosterEntries(slots).map((e) => e.label)).toEqual([
			"Toastmaster of the Day",
			"Table Topics Master",
			"Speaker 1",
			"Evaluator 1",
			"Speaker 2",
			"Evaluator 2",
			"Speaker 3",
			"Evaluator 3",
			"General Evaluator",
			"Timer",
		]);
	});

	it("keeps General Evaluator out of the pairing (uses the higher-count evaluator role)", () => {
		const slots = [
			rosterSlot("Speaker", 0, "speaker", true),
			rosterSlot("Evaluator", 0, "evaluator"),
			rosterSlot("General Evaluator", 0, "evaluator"),
		];
		const labels = buildRosterEntries(slots).map((e) => e.label);
		expect(labels).toEqual(["Speaker", "Evaluator", "General Evaluator"]);
	});

	it("carries the assignee name through", () => {
		const slots = [
			rosterSlot("Speaker", 0, "speaker", true, "Jagpal Singh"),
			rosterSlot("Evaluator", 0, "evaluator", false, "Sudheer Isanaka"),
		];
		expect(buildRosterEntries(slots)).toEqual([
			{ label: "Speaker", name: "Jagpal Singh" },
			{ label: "Evaluator", name: "Sudheer Isanaka" },
		]);
	});

	it("falls back to original order when there is no evaluator to pair", () => {
		const slots = [
			rosterSlot("Toastmaster of the Day", 0, "leadership"),
			rosterSlot("Speaker", 0, "speaker", true),
			rosterSlot("Speaker", 1, "speaker", true),
		];
		expect(buildRosterEntries(slots).map((e) => e.label)).toEqual([
			"Toastmaster of the Day",
			"Speaker 1",
			"Speaker 2",
		]);
	});

	it("appends leftovers when speaker and evaluator counts differ", () => {
		const slots = [
			rosterSlot("Speaker", 0, "speaker", true),
			rosterSlot("Speaker", 1, "speaker", true),
			rosterSlot("Speaker", 2, "speaker", true),
			rosterSlot("Evaluator", 0, "evaluator"),
			rosterSlot("Evaluator", 1, "evaluator"),
		];
		expect(buildRosterEntries(slots).map((e) => e.label)).toEqual([
			"Speaker 1",
			"Evaluator 1",
			"Speaker 2",
			"Evaluator 2",
			"Speaker 3",
		]);
	});
});

describe("generateSlotRows", () => {
	it("generates the correct number of rows with 0-based slotIndex", () => {
		const defs = [{ id: "def-1", defaultCount: 3, enabled: true }];
		const rows = generateSlotRows(defs, "meeting-1");
		expect(rows).toHaveLength(3);
		expect(rows[0]).toEqual({
			meetingId: "meeting-1",
			roleDefinitionId: "def-1",
			slotIndex: 0,
		});
		expect(rows[1]).toEqual({
			meetingId: "meeting-1",
			roleDefinitionId: "def-1",
			slotIndex: 1,
		});
		expect(rows[2]).toEqual({
			meetingId: "meeting-1",
			roleDefinitionId: "def-1",
			slotIndex: 2,
		});
	});

	it("yields no rows for defaultCount: 0", () => {
		const rows = generateSlotRows(
			[{ id: "def-1", defaultCount: 0, enabled: true }],
			"meeting-1",
		);
		expect(rows).toHaveLength(0);
	});

	it("flattens multiple defs in order", () => {
		const defs = [
			{ id: "def-a", defaultCount: 2, enabled: true },
			{ id: "def-b", defaultCount: 1, enabled: true },
		];
		const rows = generateSlotRows(defs, "meeting-x");
		expect(rows).toHaveLength(3);
		expect(rows[0].roleDefinitionId).toBe("def-a");
		expect(rows[1].roleDefinitionId).toBe("def-a");
		expect(rows[2].roleDefinitionId).toBe("def-b");
	});

	it("returns [] for empty defs", () => {
		expect(generateSlotRows([], "meeting-1")).toEqual([]);
	});

	it("skips a disabled role definition entirely (#368)", () => {
		const defs = [
			{ id: "def-1", defaultCount: 3, enabled: true },
			{ id: "def-2", defaultCount: 2, enabled: false },
		];
		const rows = generateSlotRows(defs, "meeting-1");
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.roleDefinitionId === "def-1")).toBe(true);
	});

	it("yields no rows when every def is disabled", () => {
		const defs = [
			{ id: "def-1", defaultCount: 3, enabled: false },
			{ id: "def-2", defaultCount: 2, enabled: false },
		];
		expect(generateSlotRows(defs, "meeting-1")).toEqual([]);
	});
});

describe("buildRoleCounts + slotLabel", () => {
	it("returns bare role name when the role appears only once", () => {
		const slots = [{ roleName: "Toastmaster", slotIndex: 0 }];
		const counts = buildRoleCounts(slots);
		expect(slotLabel({ roleName: "Toastmaster", slotIndex: 0 }, counts)).toBe(
			"Toastmaster",
		);
	});

	it("numbers repeated roles starting at 1", () => {
		const slots = [
			{ roleName: "Speaker", slotIndex: 0 },
			{ roleName: "Speaker", slotIndex: 1 },
			{ roleName: "Speaker", slotIndex: 2 },
		];
		const counts = buildRoleCounts(slots);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 0 }, counts)).toBe(
			"Speaker 1",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 1 }, counts)).toBe(
			"Speaker 2",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 2 }, counts)).toBe(
			"Speaker 3",
		);
	});

	it("handles mixed single and repeated roles", () => {
		const slots = [
			{ roleName: "Toastmaster", slotIndex: 0 },
			{ roleName: "Speaker", slotIndex: 0 },
			{ roleName: "Speaker", slotIndex: 1 },
		];
		const counts = buildRoleCounts(slots);
		expect(slotLabel({ roleName: "Toastmaster", slotIndex: 0 }, counts)).toBe(
			"Toastmaster",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 0 }, counts)).toBe(
			"Speaker 1",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 1 }, counts)).toBe(
			"Speaker 2",
		);
	});
});

describe("resolveEvaluatorLinks", () => {
	it("populates evaluates when evaluatesSlotId matches a speaker row", () => {
		const rows = [
			{
				id: "slot-speaker",
				evaluatesSlotId: null,
				assigneeName: "Alice",
				speechTitle: "My Ice Breaker",
			},
			{
				id: "slot-evaluator",
				evaluatesSlotId: "slot-speaker",
				assigneeName: "Bob",
				speechTitle: null,
			},
		];
		const result = resolveEvaluatorLinks(rows);
		const evaluatorRow = result.find((r) => r.id === "slot-evaluator");
		expect(evaluatorRow?.evaluates).toEqual({
			slotId: "slot-speaker",
			speakerName: "Alice",
			speechTitle: "My Ice Breaker",
		});
	});

	it("sets evaluates to null when evaluatesSlotId is null", () => {
		const rows = [
			{
				id: "slot-speaker",
				evaluatesSlotId: null,
				assigneeName: "Alice",
				speechTitle: "My Ice Breaker",
			},
		];
		const result = resolveEvaluatorLinks(rows);
		expect(result[0].evaluates).toBeNull();
	});

	it("sets evaluates to null for a dangling evaluatesSlotId (no matching row)", () => {
		const rows = [
			{
				id: "slot-evaluator",
				evaluatesSlotId: "nonexistent-slot",
				assigneeName: "Bob",
				speechTitle: null,
			},
		];
		const result = resolveEvaluatorLinks(rows);
		expect(result[0].evaluates).toBeNull();
	});

	it("preserves all other fields on the row", () => {
		const rows = [
			{
				id: "slot-1",
				evaluatesSlotId: null,
				assigneeName: "Alice",
				speechTitle: "Hello",
				extraField: "preserved",
			},
		];
		const result = resolveEvaluatorLinks(rows);
		expect(result[0].extraField).toBe("preserved");
	});
});

describe("roleAbbrev", () => {
	it("uses initials for multi-word names", () => {
		expect(roleAbbrev("General Evaluator")).toBe("GE");
		expect(roleAbbrev("Table Topics Master")).toBe("TTM");
	});
	it("drops stopwords", () => {
		expect(roleAbbrev("Toastmaster of the Day")).toBe("TD");
	});
	it("uses clean consonant-based codes for single-word names", () => {
		expect(roleAbbrev("Speaker")).toBe("SP");
		expect(roleAbbrev("Timer")).toBe("TMR");
		expect(roleAbbrev("Evaluator")).toBe("EV");
		expect(roleAbbrev("Grammarian")).toBe("GRM");
	});
	it("derives consonant codes for uncommon single-word names", () => {
		expect(roleAbbrev("Wordmaster")).toBe("WRD");
		expect(roleAbbrev("Inspiration")).toBe("INS");
	});
	it("falls back to ? for an empty name", () => {
		expect(roleAbbrev("")).toBe("?");
	});
	it("slices CODE POINTS on the no-letters path, never half a surrogate pair", () => {
		// `name.slice(0, 4)` counts UTF-16 code units, so a role name whose first
		// four units end mid-pair emitted a lone high surrogate: measured,
		// `roleAbbrev("①🎤🎤")` returned `"①🎤\ud83c"`. That renders as a
		// replacement glyph on the attendance rail's badge, and
		// `encodeURIComponent` throws `URIError: URI malformed` on it — a live
		// hazard for any consumer that puts a code in a URL.
		//
		// Three points, so nothing here can be satisfied by half the fix: the
		// SHORT name must round-trip whole, the LONG one must still be capped (at
		// four code points, not four units), and both must be well formed. A cap
		// assertion alone passes for `[...name].join("")` with no slice at all.
		expect(roleAbbrev("①🎤🎤")).toBe("①🎤🎤");
		expect(roleAbbrev("🎤🎤🎤🎤🎤")).toBe("🎤🎤🎤🎤");
		for (const name of ["①🎤🎤", "🎤🎤🎤🎤🎤", "日本語のロール"]) {
			const code = roleAbbrev(name);
			expect([...code].length).toBeLessThanOrEqual(4);
			expect(() => encodeURIComponent(code)).not.toThrow();
		}
	});
});

describe("buildShortCodes", () => {
	it("numbers repeated roles and keeps singletons unnumbered", () => {
		const codes = buildShortCodes([
			{ roleDefinitionId: "s", slotIndex: 0, name: "Speaker" },
			{ roleDefinitionId: "s", slotIndex: 1, name: "Speaker" },
			{ roleDefinitionId: "s", slotIndex: 2, name: "Speaker" },
			{ roleDefinitionId: "t", slotIndex: 0, name: "Timer" },
		]);
		expect(codes.get("s:0")).toBe("SP1");
		expect(codes.get("s:2")).toBe("SP3");
		expect(codes.get("t:0")).toBe("TMR");
	});
	it("disambiguates two different names that share a base code", () => {
		const codes = buildShortCodes([
			{ roleDefinitionId: "a", slotIndex: 0, name: "Tall Tales" },
			{ roleDefinitionId: "b", slotIndex: 0, name: "Topic Time" },
		]);
		expect(codes.get("a:0")).toBe("TT");
		expect(codes.get("b:0")).toBe("TT#2");
	});
	it("returns an empty Map for no rows", () => {
		expect(buildShortCodes([]).size).toBe(0);
	});
});

describe("resolveAssignAction", () => {
	it("open slot claims; speaker flags TBA", () => {
		expect(
			resolveAssignAction({ status: "open", isSpeakerRole: false }),
		).toEqual({ kind: "claim", speakerTba: false });
		expect(
			resolveAssignAction({ status: "open", isSpeakerRole: true }),
		).toEqual({ kind: "claim", speakerTba: true });
	});

	it("filled slot reassigns", () => {
		expect(
			resolveAssignAction({ status: "claimed", isSpeakerRole: true }),
		).toEqual({ kind: "reassign", speakerTba: false });
		expect(
			resolveAssignAction({ status: "confirmed", isSpeakerRole: false }),
		).toEqual({ kind: "reassign", speakerTba: false });
	});
});

describe("buildPickerRows", () => {
	const roster = [
		{ id: "c", name: "Cara" },
		{ id: "a", name: "Ana" },
		{ id: "b", name: "Ben" },
	];

	it("sorts free members first, then already-assigned, then unavailable (#377)", () => {
		const rows = buildPickerRows(roster, { b: "Timer" }, ["a"]);
		// Free (Cara), then already-holds-a-role (Ben), then unavailable (Ana) —
		// three tiers, NOT one trailing "flagged" bucket.
		expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			unavailable: true,
			currentRole: null,
		});
		expect(rows.find((r) => r.id === "b")).toMatchObject({
			unavailable: false,
			currentRole: "Timer",
		});
	});

	it("alphabetizes within each of the three tiers (#377)", () => {
		const mixed = [
			{ id: "u2", name: "Zoe Out" },
			{ id: "f2", name: "Bea Free" },
			{ id: "a2", name: "Yuri Busy" },
			{ id: "f1", name: "Ada Free" },
			{ id: "a1", name: "Xander Busy" },
			{ id: "u1", name: "Willa Out" },
		];
		const rows = buildPickerRows(mixed, { a1: "Timer", a2: "Ah-Counter" }, [
			"u1",
			"u2",
		]);
		// The alphabet restarts exactly twice — once per tier boundary.
		expect(rows.map((r) => r.id)).toEqual([
			"f1",
			"f2", // tier 1: available + unassigned
			"a1",
			"a2", // tier 2: already holding a role here
			"u1",
			"u2", // tier 3: marked Not Available
		]);
	});

	it("puts an unavailable member who also holds a role in the last tier (#377)", () => {
		// "Not coming at all" is the stronger signal than "here but busy".
		const rows = buildPickerRows(
			[
				{ id: "x", name: "Xena" },
				{ id: "a", name: "Ada" },
			],
			{ x: "Timer" },
			["x"],
		);
		expect(rows.map((r) => r.id)).toEqual(["a", "x"]);
		expect(rows[1]).toMatchObject({ unavailable: true, currentRole: "Timer" });
	});

	it("defaults lastServedAt to null (never) when no recency map is given", () => {
		const rows = buildPickerRows(roster, {}, []);
		expect(rows.every((r) => r.lastServedAt === null)).toBe(true);
	});

	it("attaches lastServedAt per member without changing order", () => {
		const when = new Date("2026-06-01T00:00:00Z");
		const rows = buildPickerRows(roster, {}, [], { a: when });
		// Ordering is by name only (no flags here): Ana, Ben, Cara.
		expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
		expect(rows.find((r) => r.id === "a")?.lastServedAt).toBe(when);
		expect(rows.find((r) => r.id === "b")?.lastServedAt).toBeNull();
	});
});

describe("formatLastServed", () => {
	const now = new Date("2026-07-10T12:00:00Z");
	const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

	it("returns Never for null", () => {
		expect(formatLastServed(null, now)).toBe("Never");
	});

	it("buckets recent dates by day/week/month/year", () => {
		expect(formatLastServed(daysAgo(0), now)).toBe("today");
		expect(formatLastServed(daysAgo(1), now)).toBe("yesterday");
		expect(formatLastServed(daysAgo(3), now)).toBe("3 days ago");
		expect(formatLastServed(daysAgo(21), now)).toBe("3 wks ago");
		expect(formatLastServed(daysAgo(7), now)).toBe("1 wk ago");
		expect(formatLastServed(daysAgo(90), now)).toBe("3 mo ago");
		expect(formatLastServed(daysAgo(800), now)).toBe("2 yrs ago");
	});
});

describe("summarizeAgenda", () => {
	const slot = (
		assigneeId: string | null,
		status: string,
		isSpeakerRole = false,
	) => ({ assigneeId, status, isSpeakerRole });

	it("tallies fill, confirmed, and speaker counts with rounded percentage", () => {
		const summary = summarizeAgenda([
			slot("m1", "confirmed", true),
			slot("m2", "claimed", true),
			slot(null, "open", true),
			slot("m3", "confirmed"),
			slot(null, "open"),
		]);
		expect(summary).toEqual({
			total: 5,
			filled: 3,
			open: 2,
			pct: 60,
			confirmed: 2,
			speakerTotal: 3,
			speakerFilled: 2,
		});
	});

	it("returns 0% for no slots", () => {
		expect(summarizeAgenda([]).pct).toBe(0);
	});

	it("counts a guest-held slot as filled/confirmed like a member (#151)", () => {
		const summary = summarizeAgenda([
			// guest speaker: no member id, but a guest id → filled + speakerFilled
			{
				assigneeId: null,
				assigneeGuestId: "g1",
				status: "confirmed",
				isSpeakerRole: true,
			},
			{
				assigneeId: "m1",
				assigneeGuestId: null,
				status: "claimed",
				isSpeakerRole: false,
			},
			{
				assigneeId: null,
				assigneeGuestId: null,
				status: "open",
				isSpeakerRole: false,
			},
		]);
		expect(summary).toMatchObject({
			total: 3,
			filled: 2,
			open: 1,
			confirmed: 1,
			speakerTotal: 1,
			speakerFilled: 1,
		});
	});
});

describe("assigneeDisplayName (guest marker, #151)", () => {
	it("appends the Guest marker for a guest assignee", () => {
		expect(assigneeDisplayName("Ben Carter", true)).toBe("Ben Carter · Guest");
	});
	it("leaves a member name unmarked", () => {
		expect(assigneeDisplayName("Rehanna Khan", false)).toBe("Rehanna Khan");
		expect(assigneeDisplayName("Rehanna Khan")).toBe("Rehanna Khan");
	});
	it("returns null for an unassigned slot", () => {
		expect(assigneeDisplayName(null, true)).toBeNull();
	});
});

/**
 * #624. A contest's speaking order is drawn by lot at the briefing, so a
 * contestant role's `slot_index` is sign-up order wearing a rank. A role whose
 * definition says its slots are UNORDERED prints without a number, and the
 * roster collapses its slots into one entry naming every holder.
 */
describe("slotLabel — an unordered role never numbers its slots (#624)", () => {
	const counts = { Contestant: 4, Speaker: 3 };

	it("drops the number when the role's slots are unordered", () => {
		expect(
			slotLabel(
				{ roleName: "Contestant", slotIndex: 2, slotsUnordered: true },
				counts,
			),
		).toBe("Contestant");
	});

	it("still numbers an ORDERED role with several slots", () => {
		expect(
			slotLabel(
				{ roleName: "Speaker", slotIndex: 2, slotsUnordered: false },
				counts,
			),
		).toBe("Speaker 3");
		// The flag is optional on the slot shape: every existing caller passes a
		// slot without it, and those must keep numbering exactly as before.
		expect(slotLabel({ roleName: "Speaker", slotIndex: 0 }, counts)).toBe(
			"Speaker 1",
		);
	});
});

describe("slotAccessibleLabel — an unordered role's controls stay tellable apart (#624)", () => {
	const counts = { Contestant: 3, Speaker: 3 };

	it("appends the holder's name once the number is gone", () => {
		// Three "Move Contestant up" buttons are indistinguishable to a screen
		// reader browsing by control; the number used to do this job.
		expect(
			slotAccessibleLabel(
				{
					roleName: "Contestant",
					slotIndex: 1,
					slotsUnordered: true,
					assigneeName: "Rehanna Khan",
				},
				counts,
			),
		).toBe("Contestant (Rehanna Khan)");
	});

	it("is just the label for an ORDERED role, whose number already does the job", () => {
		expect(
			slotAccessibleLabel(
				{ roleName: "Speaker", slotIndex: 1, assigneeName: "Rehanna Khan" },
				counts,
			),
		).toBe("Speaker 2");
	});

	it("is just the label for an OPEN unordered slot", () => {
		expect(
			slotAccessibleLabel(
				{
					roleName: "Contestant",
					slotIndex: 1,
					slotsUnordered: true,
					assigneeName: null,
				},
				counts,
			),
		).toBe("Contestant");
	});
});

describe("buildRosterEntries — an unordered role collapses into one entry (#624)", () => {
	const slot = (
		roleName: string,
		slotIndex: number,
		assigneeName: string | null,
		over: Partial<{
			category: "leadership" | "speaker" | "evaluator" | "functionary";
			isSpeakerRole: boolean;
			slotsUnordered: boolean;
			assigneeIsGuest: boolean;
		}> = {},
	) => ({
		roleName,
		slotIndex,
		category: "functionary" as const,
		isSpeakerRole: false,
		assigneeName,
		...over,
	});
	const contestant = (i: number, name: string | null, isGuest = false) =>
		slot("Contestant", i, name, {
			category: "speaker",
			isSpeakerRole: true,
			slotsUnordered: true,
			assigneeIsGuest: isGuest,
		});

	it("names every holder in one entry, in the role's position, unnumbered", () => {
		const slots = [
			slot("Contest Chair", 0, "Rasheed Bustamam", { category: "leadership" }),
			contestant(0, "Faisal Ali"),
			contestant(1, "Rehanna Khan"),
			contestant(2, "Jagpal Singh"),
			contestant(3, "Riyaz Mohammed"),
			slot("Contest Timer", 0, "Saif"),
		];
		expect(buildRosterEntries(slots)).toEqual([
			{ label: "Contest Chair", name: "Rasheed Bustamam" },
			{
				label: "Contestant",
				name: "Faisal Ali, Rehanna Khan, Jagpal Singh, and Riyaz Mohammed",
				holderCount: 4,
			},
			{ label: "Contest Timer", name: "Saif" },
		]);
	});

	it("uses the same list punctuation as the run of show", () => {
		// `Intl.ListFormat` with the Oxford comma — the printed sheet's "Contest
		// speeches" row joins the same four names, and the two must read alike.
		const two = buildRosterEntries([
			contestant(0, "Faisal Ali"),
			contestant(1, "Rehanna Khan"),
		]);
		expect(two[0]?.name).toBe("Faisal Ali and Rehanna Khan");
	});

	it("marks each guest holder individually", () => {
		const entries = buildRosterEntries([
			contestant(0, "Faisal Ali"),
			contestant(1, "Ben Carter", true),
		]);
		expect(entries).toEqual([
			{
				label: "Contestant",
				name: "Faisal Ali and Ben Carter · Guest",
				holderCount: 2,
			},
		]);
	});

	it("reads as a single open entry when nobody holds the role", () => {
		expect(
			buildRosterEntries([contestant(0, null), contestant(1, null)]),
		).toEqual([{ label: "Contestant", name: null, holderCount: 0 }]);
	});

	it("shows at most ONE open placeholder beside the holders it has", () => {
		// Same rule as `agenda-template-rows.ts`'s collapseOpen: a role nobody
		// has fully staffed must still say so, once, not once per empty place.
		const entries = buildRosterEntries([
			contestant(0, "Faisal Ali"),
			contestant(1, null),
			contestant(2, null),
		]);
		expect(entries).toEqual([
			{
				label: "Contestant",
				name: `Faisal Ali and ${OPEN_LABEL}`,
				holderCount: 1,
			},
		]);
	});

	it("leaves an ORDERED role with several slots as one numbered entry each", () => {
		const slots = [
			slot("Speaker", 0, "Jagpal Singh", {
				category: "speaker",
				isSpeakerRole: true,
			}),
			slot("Speaker", 1, "Sudheer Isanaka", {
				category: "speaker",
				isSpeakerRole: true,
			}),
		];
		expect(buildRosterEntries(slots)).toEqual([
			{ label: "Speaker 1", name: "Jagpal Singh" },
			{ label: "Speaker 2", name: "Sudheer Isanaka" },
		]);
	});

	it("keeps the original order instead of pairing when the SPEAKER side is collapsed", () => {
		// Pairing puts one speaker beside one evaluator per row. A collapsed entry
		// stands for several people and takes a full row once it names two, so
		// there is no row for a partner to share: the roster keeps its original
		// order rather than interleaving a list against a single entry. No shipped
		// template has unordered speakers AND evaluators; this pins the rule.
		const slots = [
			contestant(0, "A"),
			contestant(1, "B"),
			slot("Evaluator", 0, "E1", { category: "evaluator" }),
			slot("Evaluator", 1, "E2", { category: "evaluator" }),
		];
		expect(buildRosterEntries(slots).map((e) => e.label)).toEqual([
			"Contestant",
			"Evaluator 1",
			"Evaluator 2",
		]);
	});

	it("keeps the original order when the paired EVALUATOR role is the unordered one", () => {
		// The mirror case, and the one the interleave got wrong: with one
		// collapsed evaluator item it emitted [Speaker 1, Evaluator, Speaker 2],
		// a full-width evaluator row wedged between two speakers.
		const slots = [
			slot("Speaker", 0, "S1", { category: "speaker", isSpeakerRole: true }),
			slot("Speaker", 1, "S2", { category: "speaker", isSpeakerRole: true }),
			slot("Evaluator", 0, "E1", {
				category: "evaluator",
				slotsUnordered: true,
			}),
			slot("Evaluator", 1, "E2", {
				category: "evaluator",
				slotsUnordered: true,
			}),
		];
		expect(buildRosterEntries(slots)).toEqual([
			{ label: "Speaker 1", name: "S1" },
			{ label: "Speaker 2", name: "S2" },
			{ label: "Evaluator", name: "E1 and E2", holderCount: 2 },
		]);
	});

	it("keeps the original order when the collapsed speaker role has only ONE holder", () => {
		// `collapsedSide` tests for the PRESENCE of a holder count, not for a
		// count above one, and the comment beside it says why: with 0 or 1 holders
		// the entry still stands for the whole role, so there is still no
		// per-speaker partner. Nothing exercised that claim — every other
		// collapsed fixture names two or more, and with a single speaker-side item
		// the interleave happens to emit the original order anyway. This is the
		// arrangement where the two answers differ: under `holderCount > 1` the
		// roster would come back interleaved.
		const slots = [
			contestant(0, "A1"),
			slot("Speaker", 0, "S1", { category: "speaker", isSpeakerRole: true }),
			slot("Speaker", 1, "S2", { category: "speaker", isSpeakerRole: true }),
			slot("Evaluator", 0, "E1", { category: "evaluator" }),
			slot("Evaluator", 1, "E2", { category: "evaluator" }),
		];
		expect(buildRosterEntries(slots).map((e) => e.label)).toEqual([
			"Contestant",
			"Speaker 1",
			"Speaker 2",
			"Evaluator 1",
			"Evaluator 2",
		]);
	});

	it("keeps the original order when the collapsed speaker role has NO holder", () => {
		const slots = [
			contestant(0, null),
			slot("Speaker", 0, "S1", { category: "speaker", isSpeakerRole: true }),
			slot("Speaker", 1, "S2", { category: "speaker", isSpeakerRole: true }),
			slot("Evaluator", 0, "E1", { category: "evaluator" }),
			slot("Evaluator", 1, "E2", { category: "evaluator" }),
		];
		expect(buildRosterEntries(slots).map((e) => e.label)).toEqual([
			"Contestant",
			"Speaker 1",
			"Speaker 2",
			"Evaluator 1",
			"Evaluator 2",
		]);
	});

	it("groups by role DEFINITION, so an ordered role sharing the name keeps its own entries", () => {
		const slots = [
			{ ...contestant(0, "A1"), roleDefinitionId: "def-unordered" },
			{ ...contestant(1, "A2"), roleDefinitionId: "def-unordered" },
			{
				...slot("Contestant", 0, "B1", {
					category: "speaker",
					isSpeakerRole: true,
				}),
				roleDefinitionId: "def-ordered",
			},
		];
		expect(buildRosterEntries(slots)).toEqual([
			{ label: "Contestant", name: "A1 and A2", holderCount: 2 },
			// Numbered off the NAME's total count, as every same-named role always
			// was; the point here is that B1 is not swallowed into the list above.
			{ label: "Contestant 1", name: "B1" },
		]);
	});

	it("never absorbs an ORDERED slot into the collapsed entry, even without definition ids", () => {
		// Fixtures (and any caller that omits `roleDefinitionId`) group by name;
		// the grouping must still only gather slots that are themselves unordered.
		const slots = [
			contestant(0, "A1"),
			contestant(1, "A2"),
			slot("Contestant", 0, "B1", { category: "speaker", isSpeakerRole: true }),
		];
		expect(buildRosterEntries(slots)).toEqual([
			{ label: "Contestant", name: "A1 and A2", holderCount: 2 },
			{ label: "Contestant 1", name: "B1" },
		]);
	});
});

describe("rosterGridPositions — a multi-holder entry takes a whole row (#624)", () => {
	it("lays ordinary entries two to a row", () => {
		expect(rosterGridPositions([{}, {}, {}])).toEqual([
			{ row: 0, col: 0, wide: false, lastInColumn: false },
			{ row: 0, col: 1, wide: false, lastInColumn: true },
			{ row: 1, col: 0, wide: false, lastInColumn: true },
		]);
	});

	it("gives an entry naming several people its own full-width row", () => {
		expect(rosterGridPositions([{}, {}, { holderCount: 4 }, {}, {}])).toEqual([
			{ row: 0, col: 0, wide: false, lastInColumn: false },
			{ row: 0, col: 1, wide: false, lastInColumn: false },
			{ row: 1, col: 0, wide: true, lastInColumn: false },
			{ row: 2, col: 0, wide: false, lastInColumn: true },
			{ row: 2, col: 1, wide: false, lastInColumn: true },
		]);
	});

	it("starts a new row for the wide entry when the left cell is taken", () => {
		expect(rosterGridPositions([{}, { holderCount: 2 }, {}])).toEqual([
			{ row: 0, col: 0, wide: false, lastInColumn: false },
			{ row: 1, col: 0, wide: true, lastInColumn: false },
			{ row: 2, col: 0, wide: false, lastInColumn: true },
		]);
	});

	it("keeps a collapsed entry with ONE holder in an ordinary cell", () => {
		// "Faisal Ali and — open —" fits half a row; only a list of several
		// earns the width.
		expect(
			rosterGridPositions([{ holderCount: 1 }, { holderCount: 0 }]),
		).toEqual([
			{ row: 0, col: 0, wide: false, lastInColumn: true },
			{ row: 0, col: 1, wide: false, lastInColumn: true },
		]);
	});

	/**
	 * The boxed roster drops a cell's bottom rule when nothing sits below it, so
	 * this flag decides how EVERY club's ordinary agenda is ruled, not just a
	 * contest's. The old code found those cells as "the last two entries", which
	 * is right only for an even count; a roster with an odd count — the common
	 * case, MCF's standard sheet has eleven roles — leaves the final row half
	 * empty, and the cell above that empty half has nothing under it either.
	 * Reproducing the old answer exactly for an unordered-free roster is the
	 * point: this change must not restyle a sheet no contest is involved in.
	 */
	it("closes BOTH trailing cells of an odd roster, exactly as the old rule did", () => {
		const odd = rosterGridPositions([{}, {}, {}, {}, {}]);
		expect(odd.map((p) => p.lastInColumn)).toEqual([
			false,
			false,
			false,
			true, // right column, row 1 — the empty half of row 2 is below it
			true, // left column, row 2 — the last cell
		]);
	});

	it("closes only the final row of an even roster", () => {
		expect(
			rosterGridPositions([{}, {}, {}, {}]).map((p) => p.lastInColumn),
		).toEqual([false, false, true, true]);
	});

	it("treats a wide entry as covering both columns beneath it", () => {
		// Neither cell of row 0 is closed: the full-width entry below spans them.
		expect(
			rosterGridPositions([{}, {}, { holderCount: 3 }]).map(
				(p) => p.lastInColumn,
			),
		).toEqual([false, false, true]);
	});
});
