/**
 * DB-backed tests for `get_agenda`'s `readiness` field (#963).
 *
 * `readiness` is `meetingReadiness(...)` over the SAME `loadMeetingSlots` rows
 * the tool already returns, so this suite proves three things the pure function's
 * own tests cannot see: that the tool reads `table_topics_notes` (a column it did
 * not select before), that it routes a cancelled, completed or past meeting to
 * `null`, and that a guest holder's gap carries a name and nothing else.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/get-agenda-readiness.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	guests,
	meetings,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import type { MeetingReadiness } from "#/lib/meeting-readiness";
import { meetingReadiness } from "#/lib/meeting-readiness";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getAgendaTool } = await import("#/server/mcp/tools/get-agenda");
const { loadMeetingSlots } = await import("#/server/meeting-slots-logic");
const { hashApiToken } = await import("#/server/api-tokens-logic");

interface AgendaOut {
	status: string;
	readiness: MeetingReadiness | null;
	slots: { role: string }[];
}

describe.skipIf(!hasTestDb)("get_agenda readiness (#963)", () => {
	let seed: SeededClub;
	let token: string;

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	const getAgenda = async () =>
		(await getAgendaTool.handler(
			{ meetingId: seed.meetingId },
			{ rawToken: token },
		)) as AgendaOut;

	async function role(name: string, key: string | null, isSpeaker = false) {
		const [row] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name,
				key,
				category: "functionary",
				isSpeakerRole: isSpeaker,
			})
			.returning({ id: roleDefinitions.id });
		if (!row) throw new Error("role insert failed");
		return row.id;
	}

	async function slotFor(
		roleDefinitionId: string,
		values: Partial<typeof roleSlots.$inferInsert> = {},
	) {
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId,
				status: "open",
				...values,
			})
			.returning({ id: roleSlots.id });
		if (!row) throw new Error("slot insert failed");
		return row.id;
	}

	beforeEach(async () => {
		seed = await seedClub();
		token = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("a scheduled future meeting returns the readiness the pure function computes from the same rows", async () => {
		// seedClub's one Timer slot is open. Add a claimed Toastmaster with no
		// theme, a confirmed Grammarian with a Word of the Day, and a claimed
		// Speaker whose title is still the TBA placeholder.
		const tmodRole = await role(
			"Toastmaster of the Day",
			"toastmaster_of_the_day",
		);
		const gramRole = await role("Grammarian", "grammarian");
		const speakerRole = await role("Speaker", "speaker", true);
		await slotFor(tmodRole, {
			status: "claimed",
			assignedMemberId: seed.memberId,
		});
		await slotFor(gramRole, {
			status: "confirmed",
			assignedMemberId: seed.adminMemberId,
		});
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId: seed.personId, title: "TBA" })
			.returning({ id: speeches.id });
		await slotFor(speakerRole, {
			status: "claimed",
			assignedMemberId: seed.memberId,
			speechId: speech?.id,
		});
		await testDb
			.update(meetings)
			.set({ wordOfTheDay: "ephemeral", tableTopicsNotes: "unused here" })
			.where(eq(meetings.id, seed.meetingId));

		const out = await getAgenda();

		expect(out.status).toBe("scheduled");
		expect(out.readiness).not.toBeNull();
		const byId = new Map(out.readiness?.items.map((i) => [i.id, i]));
		expect(out.readiness?.ready).toBe(false);
		// Timer open, the other three held.
		expect(byId.get("roles_filled")).toMatchObject({ doneCount: 3, total: 4 });
		expect(byId.get("roles_filled")?.gaps).toEqual([
			{
				slotId: seed.slotId,
				slotLabel: "Timer",
				holderName: null,
			},
		]);
		// Two claimed (Toastmaster, Speaker), one confirmed (Grammarian).
		expect(byId.get("roles_confirmed")).toMatchObject({
			doneCount: 1,
			total: 3,
		});
		expect(byId.get("meeting_theme")).toMatchObject({ doneCount: 0, total: 1 });
		// The Word of the Day is set, so its item is done and has no gap.
		expect(byId.get("word_of_the_day")).toMatchObject({
			doneCount: 1,
			total: 1,
			done: true,
			gaps: [],
		});
		// No Table Topics Master slot: the item is omitted, not shown as done.
		expect(byId.has("table_topics")).toBe(false);
		expect(byId.get("speech_details")).toMatchObject({
			doneCount: 0,
			total: 1,
		});
		// The Timer's own duty is never reported.
		expect(out.readiness?.items.map((i) => i.id)).not.toContain("timing");

		// And it is exactly what the pure function says about the rows the tool read.
		const [meeting] = await testDb
			.select({
				theme: meetings.theme,
				wordOfTheDay: meetings.wordOfTheDay,
				tableTopicsNotes: meetings.tableTopicsNotes,
			})
			.from(meetings)
			.where(eq(meetings.id, seed.meetingId));
		if (!meeting) throw new Error("the seeded meeting is missing");
		expect(out.readiness).toEqual(
			meetingReadiness({
				meeting,
				slots: await loadMeetingSlots(seed.meetingId),
			}),
		);
	});

	it("reads the meeting's Table Topics notes, a column get_agenda did not select before", async () => {
		const topicsRole = await role("Table Topics Master", "table_topics_master");
		await slotFor(topicsRole, {
			status: "confirmed",
			assignedMemberId: seed.memberId,
		});
		const before = (await getAgenda()).readiness;
		expect(before?.items.find((i) => i.id === "table_topics")).toMatchObject({
			done: false,
			doneCount: 0,
			total: 1,
		});

		await testDb
			.update(meetings)
			.set({ tableTopicsNotes: "Ask about the best advice you were given" })
			.where(eq(meetings.id, seed.meetingId));
		const after = (await getAgenda()).readiness;
		expect(after?.items.find((i) => i.id === "table_topics")).toMatchObject({
			done: true,
			doneCount: 1,
			total: 1,
			gaps: [],
		});
	});

	it("a meeting with every item done is ready", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "confirmed", assignedMemberId: seed.memberId })
			.where(eq(roleSlots.id, seed.slotId));
		const out = await getAgenda();
		// Timer only: confirmed, and its timing duty is not this view's business.
		expect(out.readiness).toEqual({
			ready: true,
			items: [
				{
					id: "roles_filled",
					label: "Roles filled",
					done: true,
					doneCount: 1,
					total: 1,
					gaps: [],
				},
				{
					id: "roles_confirmed",
					label: "Roles confirmed",
					done: true,
					doneCount: 1,
					total: 1,
					gaps: [],
				},
			],
		});
	});

	it("readiness is null for a cancelled meeting", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		const out = await getAgenda();
		expect(out.status).toBe("cancelled");
		expect(out.readiness).toBeNull();
	});

	it("readiness is null for a completed meeting", async () => {
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		const out = await getAgenda();
		expect(out.status).toBe("completed");
		expect(out.readiness).toBeNull();
	});

	it("readiness is null for a scheduled meeting whose club-local day has passed", async () => {
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
		const out = await getAgenda();
		expect(out.status).toBe("scheduled");
		expect(out.readiness).toBeNull();
	});

	it("a guest holder's gap carries the display name and no contact detail", async () => {
		const [guest] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Gina Guest",
				email: "gina.guest@example.com",
				phone: "+15557654321",
				stage: "prospect",
			})
			.returning({ id: guests.id });
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedGuestId: guest?.id })
			.where(eq(roleSlots.id, seed.slotId));

		const out = await getAgenda();
		const confirmedGap = out.readiness?.items.find(
			(i) => i.id === "roles_confirmed",
		)?.gaps[0];
		expect(confirmedGap).toEqual({
			slotId: seed.slotId,
			slotLabel: "Timer",
			holderName: "Gina Guest",
		});
		expect(JSON.stringify(out.readiness)).not.toMatch(
			/gina\.guest@example\.com|5557654321|@/,
		);
	});
});
