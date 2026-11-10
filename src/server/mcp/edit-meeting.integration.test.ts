/**
 * DB-backed tests for `edit_meeting` (#1574).
 *
 * Card: protects=a meeting's text fields are changed from the connector only by
 * the people the app lets change each of them (officer: all; Toastmaster: all
 * but promoNote and meetingNumber; Grammarian: the word of the day; Table Topics
 * Master: the table topics notes), with no partial write;
 * fails_when=a field is allowed to a caller the app refuses, a call that mixes an
 * allowed and a refused field writes the allowed one, an omitted field is
 * cleared, or a preview writes;
 * no_claim=the writers' own diffing (`meeting-meta-patch`, `word-of-the-day`,
 * `table-topics-notes` suites) and the resolvers' tables.
 *
 * Run with a worktree's test database (`bun run worktree:setup`):
 *   bunx vitest run src/server/mcp/edit-meeting.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// A hook that runs once, right after the Table Topics probe (the last of the
// tool's three) passes: lets a test change the meeting between the probes and
// the locked re-plan, deterministically.
let afterLastProbe: (() => Promise<void>) | null = null;
vi.mock("#/server/mcp/authz-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/mcp/authz-logic")>();
	return {
		...actual,
		authorizeDelegateForMeeting: async (
			...args: Parameters<typeof actual.authorizeDelegateForMeeting>
		) => {
			const result = await actual.authorizeDelegateForMeeting(...args);
			if (args[2] === "tableTopicsNotes" && afterLastProbe) {
				const hook = afterLastProbe;
				afterLastProbe = null;
				await hook();
			}
			return result;
		},
	};
});

const {
	editMeetingTool,
	MEETING_NOT_EDITABLE_MESSAGE,
	MEETING_NUMBER_TAKEN_MESSAGE,
	NOTHING_TO_CHANGE_MESSAGE,
} = await import("#/server/mcp/tools/edit-meeting");
const { applyWodAndTableTopicsUpdate } = await import(
	"#/server/meetings-logic"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");
const { NOT_ROLE_HOLDER_MESSAGE } = await import("#/server/mcp/authz-logic");

interface Result {
	applied: boolean;
	planHash?: string;
	plan: {
		changes: Record<string, { from: unknown; to: unknown }>;
		unchanged: string[];
		blocking: { code: string; field: string }[];
	};
}

type Who = "officer" | "toastmaster" | "grammarian" | "ttm";

describe.skipIf(!hasTestDb)("edit_meeting (#1574)", () => {
	let seed: SeededClub;
	const extraUsers: string[] = [];
	const tokens = {} as Record<Who | "plain", string>;
	const memberIds = {} as Record<Who | "plain", string>;
	let toastmasterSlotId: string;

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	async function addUserMember(name: string) {
		const userId = randomUUID();
		extraUsers.push(userId);
		await testDb.insert(user).values({
			id: userId,
			name,
			email: `${userId}@test.example`,
			emailVerified: true,
		});
		const [person] = await testDb
			.insert(people)
			.values({ name, email: `${userId}@test.example`, userId })
			.returning({ id: people.id });
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: (person as { id: string }).id,
				name,
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		return { userId, memberId: (member as { id: string }).id };
	}

	async function holder(roleName: string, name: string) {
		const m = await addUserMember(name);
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: roleName,
				category: "functionary",
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: (def as { id: string }).id,
				assignedMemberId: m.memberId,
				status: "confirmed",
			})
			.returning({ id: roleSlots.id });
		return { ...m, slotId: (slot as { id: string }).id };
	}

	const call = (
		input: Record<string, unknown>,
		who: Who | "plain" = "officer",
		meetingId = seed.meetingId,
	) =>
		editMeetingTool.handler({ meetingId, ...input }, { rawToken: tokens[who] });
	const preview = async (
		input: Record<string, unknown>,
		who: Who | "plain" = "officer",
	) => (await call(input, who)) as Result;
	async function apply(
		input: Record<string, unknown>,
		who: Who | "plain" = "officer",
	) {
		const p = await preview(input, who);
		return (await call({ ...input, planHash: p.planHash }, who)) as Result;
	}
	async function row() {
		const [r] = await testDb
			.select()
			.from(meetings)
			.where(eq(meetings.id, seed.meetingId));
		return r as NonNullable<typeof r>;
	}
	async function edits() {
		return testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
	}
	async function outcome(p: Promise<unknown>) {
		try {
			return { ok: true as const, value: await p };
		} catch (err) {
			const e = err as McpErrorLike;
			return { ok: false as const, code: e.code, message: e.message, err: e };
		}
	}
	type McpErrorLike = { code?: string; message: string; detail?: unknown };

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(meetings)
			.set({ theme: "Old theme", notes: "Old notes", wodDefinition: "old def" })
			.where(eq(meetings.id, seed.meetingId));
		tokens.officer = await mint(seed.adminUserId);
		memberIds.officer = seed.adminMemberId;
		tokens.plain = await mint(seed.memberUserId);
		memberIds.plain = seed.memberId;
		const tm = await holder("Toastmaster of the Day", "Tess Master");
		tokens.toastmaster = await mint(tm.userId);
		memberIds.toastmaster = tm.memberId;
		toastmasterSlotId = tm.slotId;
		const gr = await holder("Grammarian", "Gus Grammar");
		tokens.grammarian = await mint(gr.userId);
		memberIds.grammarian = gr.memberId;
		const tt = await holder("Table Topics Master", "Tia Topics");
		tokens.ttm = await mint(tt.userId);
		memberIds.ttm = tt.memberId;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const id of extraUsers.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	// Typed from the issue's table (#1574), not derived from the tool's source:
	// every field the tool accepts, for every caller.
	const ALL_FIELDS = [
		"theme",
		"location",
		"joinUrl",
		"notes",
		"reminders",
		"wordOfTheDay",
		"wodDefinition",
		"wodExample",
		"tableTopicsNotes",
		"promoNote",
		"meetingNumber",
	];
	const ALLOWED: Record<Who, string[]> = {
		officer: ALL_FIELDS,
		toastmaster: [
			"theme",
			"location",
			"joinUrl",
			"notes",
			"reminders",
			"wordOfTheDay",
			"wodDefinition",
			"wodExample",
			"tableTopicsNotes",
		],
		grammarian: ["wordOfTheDay", "wodDefinition", "wodExample"],
		ttm: ["tableTopicsNotes"],
	};
	const MATRIX = Object.fromEntries(
		(Object.keys(ALLOWED) as Who[]).map((who) => [
			who,
			Object.fromEntries(ALL_FIELDS.map((f) => [f, ALLOWED[who].includes(f)])),
		]),
	) as Record<Who, Record<string, boolean>>;
	const SAMPLE: Record<string, unknown> = {
		theme: "New theme",
		location: "Room 9",
		joinUrl: "https://zoom.us/j/999",
		notes: "New notes",
		reminders: "New announcements",
		wordOfTheDay: "Resilient",
		wodDefinition: "new def",
		wodExample: "an example",
		tableTopicsNotes: "Ask about travel",
		promoNote: "Bring a friend",
		meetingNumber: 42,
	};

	describe("who may change what, cell by cell", () => {
		for (const [who, fields] of Object.entries(MATRIX) as [
			Who,
			Record<string, boolean>,
		][]) {
			for (const [field, allowed] of Object.entries(fields)) {
				it(`${who} ${allowed ? "may" : "may not"} change ${field}`, async () => {
					const input = { [field]: SAMPLE[field] };
					const p = await preview(input, who);
					if (allowed) {
						expect(p.plan.blocking).toEqual([]);
						await apply(input, who);
						expect(
							(await row())[field as keyof Awaited<ReturnType<typeof row>>],
						).toBe(SAMPLE[field]);
						expect(await edits()).toHaveLength(1);
					} else {
						expect(p.plan.blocking.map((b) => b.field)).toEqual([field]);
						const r = await outcome(
							call({ ...input, planHash: p.planHash }, who),
						);
						expect(r).toMatchObject({ ok: false, code: "BLOCKED" });
						expect(
							(await row())[field as keyof Awaited<ReturnType<typeof row>>],
						).not.toBe(SAMPLE[field]);
						expect(await edits()).toHaveLength(0);
					}
				});
			}
		}
	});

	it("a Toastmaster call that includes meetingNumber writes nothing, allowed fields included", async () => {
		const input = { theme: "Mixed", meetingNumber: 7 };
		const p = await preview(input, "toastmaster");
		expect(p.plan.blocking.map((b) => b.field)).toEqual(["meetingNumber"]);
		const r = await outcome(
			call({ ...input, planHash: p.planHash }, "toastmaster"),
		);
		expect(r).toMatchObject({ ok: false, code: "BLOCKED" });
		const after = await row();
		expect(after.theme).toBe("Old theme");
		expect(after.meetingNumber).toBeNull();
		expect(await edits()).toHaveLength(0);
	});

	it("a Grammarian mixing word and theme writes neither", async () => {
		const input = { wordOfTheDay: "Mixed", theme: "Nope" };
		const p = await preview(input, "grammarian");
		const r = await outcome(
			call({ ...input, planHash: p.planHash }, "grammarian"),
		);
		expect(r).toMatchObject({ ok: false, code: "BLOCKED" });
		expect((await row()).wordOfTheDay).toBeNull();
	});

	it("a caller holding both Grammarian and Table Topics Master logs one meeting_edit for fields of both", async () => {
		// The resolver reads the meeting's one Table Topics Master slot, so hand
		// that slot to the Grammarian rather than adding a second one.
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: memberIds.grammarian })
			.where(eq(roleSlots.assignedMemberId, memberIds.ttm));
		const r = await apply(
			{ wordOfTheDay: "Dual", tableTopicsNotes: "Both hats" },
			"grammarian",
		);
		expect(r.applied).toBe(true);
		const after = await row();
		expect(after.wordOfTheDay).toBe("Dual");
		expect(after.tableTopicsNotes).toBe("Both hats");
		const logged = await edits();
		expect(logged).toHaveLength(1);
		expect(logged[0]?.actorMemberId).toBe(memberIds.grammarian);
	});

	it("a preview writes nothing", async () => {
		const p = await preview({ theme: "Peek", notes: null });
		expect(p.applied).toBe(false);
		expect(p.plan.changes).toEqual({
			theme: { from: "Old theme", to: "Peek" },
			notes: { from: "Old notes", to: null },
		});
		const after = await row();
		expect(after.theme).toBe("Old theme");
		expect(after.notes).toBe("Old notes");
		expect(await edits()).toHaveLength(0);
	});

	it("an apply writes only the changed fields and logs one meeting_edit crediting the caller", async () => {
		const r = await apply(
			{ theme: "Old theme", location: "Room 9", wordOfTheDay: "Brisk" },
			"toastmaster",
		);
		expect(r.applied).toBe(true);
		expect(r.plan.unchanged).toEqual(["theme"]);
		expect(Object.keys(r.plan.changes)).toEqual(["location", "wordOfTheDay"]);
		const logs = await edits();
		expect(logs).toHaveLength(1);
		expect(logs[0]?.actorMemberId).toBe(memberIds.toastmaster);
		expect(logs[0]?.detail).toEqual({
			before: { location: null, wordOfTheDay: null },
			after: { location: "Room 9", wordOfTheDay: "Brisk" },
		});
	});

	it("an officer's own write is credited to the officer", async () => {
		await apply({ promoNote: "Promo" });
		expect((await edits())[0]?.actorMemberId).toBe(memberIds.officer);
	});

	it("null clears a field and an omitted field is unchanged, for each group", async () => {
		await testDb
			.update(meetings)
			.set({
				wordOfTheDay: "Keep",
				tableTopicsNotes: "Keep too",
				promoNote: "p",
			})
			.where(eq(meetings.id, seed.meetingId));
		await apply({ theme: null, wodDefinition: null, promoNote: null });
		const after = await row();
		expect(after.theme).toBeNull();
		expect(after.wodDefinition).toBeNull();
		expect(after.promoNote).toBeNull();
		expect(after.notes).toBe("Old notes");
		expect(after.wordOfTheDay).toBe("Keep");
		expect(after.tableTopicsNotes).toBe("Keep too");
		await apply({ tableTopicsNotes: null }, "ttm");
		expect((await row()).tableTopicsNotes).toBeNull();
		expect((await row()).wordOfTheDay).toBe("Keep");
	});

	it("joinUrl is normalized and a non-link clears it", async () => {
		await apply({ joinUrl: "zoom.us/j/123" });
		expect((await row()).joinUrl).toBe("https://zoom.us/j/123");
		await apply({ joinUrl: "tbd" });
		expect((await row()).joinUrl).toBeNull();
	});

	it("a member with no role on the meeting is refused", async () => {
		const r = await outcome(call({ theme: "x" }, "plain"));
		expect(r).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_ROLE_HOLDER_MESSAGE,
		});
	});

	it("the previous Toastmaster is refused after a reassign", async () => {
		const other = await addUserMember("New Toastmaster");
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: other.memberId })
			.where(eq(roleSlots.id, toastmasterSlotId));
		const r = await outcome(call({ theme: "x" }, "toastmaster"));
		expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("a cancelled and a completed meeting are refused", async () => {
		for (const status of ["cancelled", "completed"] as const) {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, seed.meetingId));
			const r = await outcome(call({ theme: "x" }));
			// The resolver refuses first, in its own words for each status.
			expect(r, status).toMatchObject({ ok: false, code: "LOCKED" });
			expect(r.ok === false && r.message, status).toMatch(
				status === "cancelled" ? /cancelled/ : /locked/,
			);
		}
		expect((await row()).theme).toBe("Old theme");
	});

	it("a stale planHash is PLAN_STALE and writes nothing", async () => {
		const p = await preview({ theme: "Fresh" });
		await testDb
			.update(meetings)
			.set({ theme: "Moved under you" })
			.where(eq(meetings.id, seed.meetingId));
		const r = await outcome(call({ theme: "Fresh", planHash: p.planHash }));
		expect(r).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect((await row()).theme).toBe("Moved under you");
		expect(await edits()).toHaveLength(0);
	});

	it("an empty call is a VALIDATION refusal", async () => {
		const r = await outcome(call({}));
		expect(r).toMatchObject({
			ok: false,
			code: "VALIDATION",
			message: NOTHING_TO_CHANGE_MESSAGE,
		});
		expect(r.ok === false && r.err).toBeInstanceOf(McpError);
	});

	it("a duplicate meeting number is VALIDATION, not an internal error", async () => {
		await apply({ meetingNumber: 5 });
		const [other] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const id = (other as { id: string }).id;
		const input = { meetingNumber: 5, theme: "Rolled back" };
		const p = (await call(input, "officer", id)) as Result;
		const r = await outcome(
			call({ ...input, planHash: p.planHash }, "officer", id),
		);
		expect(r).toMatchObject({
			ok: false,
			code: "VALIDATION",
			message: MEETING_NUMBER_TAKEN_MESSAGE,
		});
		const [after] = await testDb
			.select()
			.from(meetings)
			.where(eq(meetings.id, id));
		expect(after?.theme).toBeNull();
		expect(after?.meetingNumber).toBeNull();
	});

	it("a meeting completed after the probes is refused under the lock and writes nothing", async () => {
		const input = { theme: "Too late" };
		const p = await preview(input);
		afterLastProbe = async () => {
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, seed.meetingId));
		};
		const r = await outcome(call({ ...input, planHash: p.planHash }));
		expect(r).toMatchObject({
			ok: false,
			code: "LOCKED",
			message: MEETING_NOT_EDITABLE_MESSAGE,
		});
		expect((await row()).theme).toBe("Old theme");
		expect(await edits()).toHaveLength(0);
	});

	it("applyWodAndTableTopicsUpdate ignores any field outside the word of the day and table topics notes", async () => {
		await applyWodAndTableTopicsUpdate({
			meetingId: seed.meetingId,
			actorMemberId: memberIds.officer,
			wordOfTheDay: "Only this",
			theme: "Smuggled",
			notes: "Smuggled",
			promoNote: "Smuggled",
		} as Parameters<typeof applyWodAndTableTopicsUpdate>[0]);
		const after = await row();
		expect(after.wordOfTheDay).toBe("Only this");
		expect(after.theme).toBe("Old theme");
		expect(after.notes).toBe("Old notes");
		expect(after.promoNote).toBeNull();
	});
});
