import { describe, expect, it } from "vitest";
import {
	buildPickerRows,
	buildRoleCounts,
	buildRosterEntries,
	buildShortCodes,
	formatLastServed,
	generateSlotRows,
	resolveAssignAction,
	resolveEvaluatorLinks,
	roleAbbrev,
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
		const defs = [{ id: "def-1", defaultCount: 3 }];
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
			[{ id: "def-1", defaultCount: 0 }],
			"meeting-1",
		);
		expect(rows).toHaveLength(0);
	});

	it("flattens multiple defs in order", () => {
		const defs = [
			{ id: "def-a", defaultCount: 2 },
			{ id: "def-b", defaultCount: 1 },
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

	it("flags unavailable and already-assigned members, sorting them last", () => {
		const rows = buildPickerRows(roster, { b: "Timer" }, ["a"]);
		// Clean member (Cara) first, then flagged sorted by name (Ana, Ben).
		expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			unavailable: true,
			currentRole: null,
		});
		expect(rows.find((r) => r.id === "b")).toMatchObject({
			unavailable: false,
			currentRole: "Timer",
		});
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
});
