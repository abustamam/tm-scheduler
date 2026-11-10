/**
 * DB-backed tests for `set_my_speech_details` (#1571), called with a real minted
 * token.
 *
 * Card (shared): protects=a speaker sets the speech in a slot THEY hold, after
 * a preview, with the app's own save, and never a slot another member or a guest
 * holds, even when the slot changes hands between preview and apply;
 * fails_when=an omitted field is cleared, another holder's speech is written, a
 * preview writes, or the log row loses the caller or the connector proof;
 * no_claim=tokens are minted directly (no OAuth round trip).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	guests,
	meetings,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setMySpeechDetailsTool } = await import(
	"#/server/mcp/tools/set-my-speech-details"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");
const { saveSpeakerDetailsCore, SPEAKER_SLOT_NOT_YOURS_MESSAGE } = await import(
	"#/server/slots-logic"
);

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

type Preview = {
	plan: {
		slotLabel: string | null;
		changes: { field: string; before: unknown; after: unknown }[];
	};
	planHash: string;
	blocking: { code: string; message: string }[];
};

function call(token: string, args: Record<string, unknown>) {
	return setMySpeechDetailsTool.handler(args, {
		rawToken: token,
		audience: "member",
	});
}
const preview = (token: string, args: Record<string, unknown>) =>
	call(token, args) as Promise<Preview>;

/** Speaker slots in agenda order, held by `holder` (a member, a guest, or nobody). */
async function addSpeakerSlots(
	s: SeededClub,
	holders: ({ memberId: string } | { guestId: string } | null)[],
): Promise<string[]> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 5,
		})
		.returning({ id: roleDefinitions.id });
	const ids: string[] = [];
	for (const [i, h] of holders.entries()) {
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: s.meetingId,
				roleDefinitionId: def?.id ?? "",
				slotIndex: i,
				status: h ? "claimed" : "open",
				assignedMemberId: h && "memberId" in h ? h.memberId : null,
				assignedGuestId: h && "guestId" in h ? h.guestId : null,
			})
			.returning({ id: roleSlots.id });
		ids.push(slot?.id ?? "");
	}
	return ids;
}

async function speechOf(slotId: string) {
	const [row] = await testDb
		.select({ speech: speeches })
		.from(roleSlots)
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.id, slotId));
	return row?.speech ?? null;
}

async function expectMcpError(p: Promise<unknown>, code: string) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	return err as InstanceType<typeof McpError>;
}

/** Preview then apply the same input. */
async function set(token: string, args: Record<string, unknown>) {
	const p = await preview(token, args);
	return call(token, { ...args, planHash: p.planHash });
}

describe.skipIf(!hasTestDb)("set_my_speech_details (#1571)", () => {
	// Card: protects=preview writes nothing, apply writes the speech and one
	// meeting_edit row crediting the caller with before/after and the connector
	// proof; fails_when=the preview writes or the log row is not the caller's.
	it("previews each change, then applies it and logs the caller", async () => {
		const s = await club();
		const [slotId] = await addSpeakerSlots(s, [{ memberId: s.memberId }]);
		const token = await tokenFor(s.memberUserId);
		const args = {
			meetingId: s.meetingId,
			speechTitle: "Ice Breaker",
			projectName: "Ice Breaker",
			minMinutes: 4,
			maxMinutes: 6,
		};
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(p.plan.slotLabel).toBe("Speaker");
		expect(p.plan.changes).toEqual(
			expect.arrayContaining([
				{ field: "speechTitle", before: "TBA", after: "Ice Breaker" },
				{ field: "minMinutes", before: null, after: 4 },
			]),
		);
		expect(await speechOf(slotId ?? "")).toBeNull();

		await call(token, { ...args, planHash: p.planHash });
		expect(await speechOf(slotId ?? "")).toMatchObject({
			title: "Ice Breaker",
			projectName: "Ice Breaker",
			minMinutes: 4,
			maxMinutes: 6,
			personId: s.personId,
		});
		const [row] = (
			await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, s.clubId))
		).filter((r) => r.action === "meeting_edit");
		expect(row?.actorMemberId).toBe(s.memberId);
		expect(row?.detail).toMatchObject({
			change: "speaker_details",
			slotId,
			proof: "connector",
			via: "connector",
			before: { title: null },
			after: { title: "Ice Breaker" },
		});
	});

	// Card: protects=omitted means unchanged; fails_when=a title-only call nulls
	// the project, timing, introduction or URL (the writer's default).
	it("a title-only call leaves everything else as it was", async () => {
		const s = await club();
		const [slotId] = await addSpeakerSlots(s, [{ memberId: s.memberId }]);
		const token = await tokenFor(s.memberUserId);
		await set(token, {
			meetingId: s.meetingId,
			speechTitle: "First",
			introduction: "She is great.",
			pathwayPath: "Dynamic Leadership",
			projectName: "Ice Breaker",
			projectLevel: "Level 1",
			minMinutes: 5,
			maxMinutes: 7,
			presentationUrl: "https://example.com/slides",
		});
		const before = await speechOf(slotId ?? "");
		const p = await preview(token, {
			meetingId: s.meetingId,
			speechTitle: "Second",
		});
		expect(p.plan.changes.map((c) => c.field)).toEqual(["speechTitle"]);
		await call(token, {
			meetingId: s.meetingId,
			speechTitle: "Second",
			planHash: p.planHash,
		});
		expect(await speechOf(slotId ?? "")).toEqual({
			...before,
			title: "Second",
			updatedAt: expect.any(Date),
		});
	});

	it("null clears a field and nothing else", async () => {
		const s = await club();
		const [slotId] = await addSpeakerSlots(s, [{ memberId: s.memberId }]);
		const token = await tokenFor(s.memberUserId);
		await set(token, {
			meetingId: s.meetingId,
			speechTitle: "T",
			introduction: "Intro",
			projectName: "P",
		});
		await set(token, { meetingId: s.meetingId, introduction: null });
		expect(await speechOf(slotId ?? "")).toMatchObject({
			title: "T",
			introduction: null,
			projectName: "P",
		});
	});

	it("an invalid window is a VALIDATION error", async () => {
		const s = await club();
		await addSpeakerSlots(s, [{ memberId: s.memberId }]);
		const token = await tokenFor(s.memberUserId);
		await expectMcpError(
			Promise.resolve(
				call(token, { meetingId: s.meetingId, minMinutes: 9, maxMinutes: 3 }),
			),
			"VALIDATION",
		);
	});

	// Card: protects=own slot only; fails_when=another member's or a guest's
	// slot is written, or the refusal differs between them.
	it("refuses a slot held by another member or by a guest", async () => {
		const s = await club();
		const [guest] = await testDb
			.insert(guests)
			.values({
				clubId: s.clubId,
				name: "Gary Guest",
				personId: await seedPerson({ name: "Gary Guest" }),
			})
			.returning({ id: guests.id });
		const [others, guestSlot] = await addSpeakerSlots(s, [
			{ memberId: s.adminMemberId },
			{ guestId: guest?.id ?? "" },
		]);
		const token = await tokenFor(s.memberUserId);
		expect(
			(await preview(token, { meetingId: s.meetingId, speechTitle: "X" }))
				.blocking[0]?.code,
		).toBe("NO_SPEAKER_SLOT");
		for (const slotId of [others, guestSlot]) {
			const args = { meetingId: s.meetingId, slotId, speechTitle: "X" };
			const p = await preview(token, args);
			expect(p.blocking.map((b) => b.code)).toEqual(["NOT_YOUR_SLOT"]);
			await expectMcpError(
				Promise.resolve(call(token, { ...args, planHash: p.planHash })),
				"BLOCKED",
			);
			expect(await speechOf(slotId ?? "")).toBeNull();
		}
	});

	it("two held slots need a slotId", async () => {
		const s = await club();
		const [a, b] = await addSpeakerSlots(s, [
			{ memberId: s.memberId },
			{ memberId: s.memberId },
		]);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, speechTitle: "Two" };
		expect((await preview(token, args)).blocking[0]?.code).toBe(
			"SLOT_REQUIRED",
		);
		await set(token, { ...args, slotId: b });
		expect(await speechOf(a ?? "")).toBeNull();
		expect(await speechOf(b ?? "")).toMatchObject({ title: "Two" });
	});

	// Card: protects=a reassign between preview and apply never writes the new
	// holder's speech; fails_when=the apply writes the slot's new holder.
	it("a reassign between preview and apply is PLAN_STALE, nothing written", async () => {
		const s = await club();
		const [slotId] = await addSpeakerSlots(s, [{ memberId: s.memberId }]);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, speechTitle: "Mine" };
		const p = await preview(token, args);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: s.adminMemberId })
			.where(eq(roleSlots.id, slotId ?? ""));
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"PLAN_STALE",
		);
		expect(await speechOf(slotId ?? "")).toBeNull();
	});

	// Card: protects=the write site itself refuses a slot whose LOCKED holder is
	// not the caller, independent of the plan hash; fails_when=`onlyHeldBy` is
	// ignored.
	it("saveSpeakerDetailsCore refuses a slot held by someone else", async () => {
		const s = await club();
		const [slotId] = await addSpeakerSlots(s, [{ memberId: s.adminMemberId }]);
		await expect(
			testDb.transaction((tx) =>
				saveSpeakerDetailsCore(tx, {
					meetingId: s.meetingId,
					slotId: slotId ?? "",
					details: { speechTitle: "Not mine" },
					actorMemberId: s.memberId,
					proof: "connector",
					onlyHeldBy: s.memberId,
				}),
			),
		).rejects.toThrow(SPEAKER_SLOT_NOT_YOURS_MESSAGE);
		expect(await speechOf(slotId ?? "")).toBeNull();
	});

	// Card: protects=cancelled and completed meetings accept no write;
	// fails_when=a save lands on either.
	it.each([
		"cancelled",
		"completed",
	] as const)("a %s meeting is LOCKED", async (status) => {
		const s = await club();
		const [slotId] = await addSpeakerSlots(s, [{ memberId: s.memberId }]);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, speechTitle: "Late" };
		const p = await preview(token, args);
		await testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, s.meetingId));
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"LOCKED",
		);
		expect(await speechOf(slotId ?? "")).toBeNull();
	});
});
