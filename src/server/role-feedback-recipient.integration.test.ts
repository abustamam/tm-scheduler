/**
 * DB-backed tests for the recipient's side of anonymous role feedback (#986):
 * the read the dashboard's `listMyFeedback` returns, the delete, and the
 * mark-seen. Each ownership refusal first proves the SAME call succeeds for the
 * owner, so a refusal cannot pass on a broken fixture.
 *
 * `createServerFn`s cannot be invoked from vitest, so the server fns' wiring —
 * the recipient comes from `requireUser()` and from nothing the caller sends —
 * is held by the source assertions at the bottom.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings, members, roleFeedbackNotes } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { deleteMyFeedbackNote, loadFeedbackForUser, markMyFeedbackSeen } =
	await import("#/server/role-feedback-logic");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const seededClubs: SeededClub[] = [];
afterEach(async () => {
	for (const s of seededClubs.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

/** A seeded club whose meeting ENDED yesterday, so its notes are readable. */
async function endedMeeting(): Promise<SeededClub> {
	const s = await seedClub();
	seededClubs.push(s);
	await testDb
		.update(meetings)
		.set({ scheduledAt: new Date(Date.now() - DAY), lengthMinutes: 90 })
		.where(eq(meetings.id, s.meetingId));
	return s;
}

async function note(
	s: SeededClub,
	recipientMemberId: string,
	wentWell: string,
	meetingId: string = s.meetingId,
	clubId: string = s.clubId,
): Promise<string> {
	const [row] = await testDb
		.insert(roleFeedbackNotes)
		.values({
			clubId,
			meetingId,
			recipientMemberId,
			roleLabel: "Timer",
			wentWell,
		})
		.returning({ id: roleFeedbackNotes.id });
	if (!row) throw new Error("note insert failed");
	return row.id;
}

async function addMember(
	clubId: string,
	name: string,
	personId?: string,
): Promise<string> {
	const pid = personId ?? (await seedPerson({ name }));
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: pid,
			name,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

const exists = async (id: string) =>
	(
		await testDb
			.select({ id: roleFeedbackNotes.id })
			.from(roleFeedbackNotes)
			.where(eq(roleFeedbackNotes.id, id))
	).length === 1;

const seenAt = async (ids: string[]) =>
	Object.fromEntries(
		(
			await testDb
				.select({ id: roleFeedbackNotes.id, seenAt: roleFeedbackNotes.seenAt })
				.from(roleFeedbackNotes)
				.where(inArray(roleFeedbackNotes.id, ids))
		).map((r) => [r.id, r.seenAt !== null]),
	);

const texts = (r: Awaited<ReturnType<typeof loadFeedbackForUser>>) =>
	r.meetings.flatMap((m) =>
		m.roles.flatMap((x) => x.notes.map((n) => n.wentWell)),
	);

describe.skipIf(!hasTestDb)("the recipient's feedback (#986)", () => {
	it("two members at one meeting each read only their own notes", async () => {
		const s = await endedMeeting();
		await note(s, s.memberId, "for the member");
		await note(s, s.adminMemberId, "for the admin");

		expect(texts(await loadFeedbackForUser(s.memberUserId))).toEqual([
			"for the member",
		]);
		expect(texts(await loadFeedbackForUser(s.adminUserId))).toEqual([
			"for the admin",
		]);
	});

	it("carries the club's timezone for the date, and no writer-identifying field", async () => {
		const s = await endedMeeting();
		await testDb
			.update(clubs)
			.set({ timezone: "America/Los_Angeles" })
			.where(eq(clubs.id, s.clubId));
		await note(s, s.memberId, "hi");
		const res = await loadFeedbackForUser(s.memberUserId);
		expect(res.meetings[0]?.timezone).toBe("America/Los_Angeles");
		// The whole shape, by key: nothing here can name a writer.
		expect(Object.keys(res.meetings[0] ?? {}).sort()).toEqual([
			"clubName",
			"meetingDate",
			"meetingId",
			"roles",
			"timezone",
		]);
		expect(
			Object.keys(res.meetings[0]?.roles[0]?.notes[0] ?? {}).sort(),
		).toEqual(["createdAt", "id", "seen", "tryNext", "wentWell"]);
	});

	it("never returns a note whose meeting has not yet ended", async () => {
		const s = await endedMeeting();
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 10 * MIN) })
			.where(eq(meetings.id, s.meetingId));
		await note(s, s.memberId, "too early");
		expect(await loadFeedbackForUser(s.memberUserId)).toEqual({
			meetings: [],
			unseenCount: 0,
		});
	});

	describe("deleteMyFeedbackNote", () => {
		it("deletes the caller's own note", async () => {
			const s = await endedMeeting();
			const id = await note(s, s.memberId, "mine");
			expect(await deleteMyFeedbackNote(s.memberUserId, id)).toEqual({
				deleted: true,
			});
			expect(await exists(id)).toBe(false);
		});

		it("a member of the same club cannot delete someone else's note, and learns nothing", async () => {
			const s = await endedMeeting();
			const theirs = await note(s, s.adminMemberId, "the admin's");
			// Same club, same meeting, signed in: still nothing.
			const res = await deleteMyFeedbackNote(s.memberUserId, theirs);
			expect(await exists(theirs)).toBe(true);
			// The SAME answer as a note that never existed.
			expect(res).toEqual(
				await deleteMyFeedbackNote(s.memberUserId, crypto.randomUUID()),
			);
			expect(res).toEqual({ deleted: false });
			// And the owner can: the refusal was about ownership, not the row.
			expect(await deleteMyFeedbackNote(s.adminUserId, theirs)).toEqual({
				deleted: true,
			});
		});

		it("does not delete the caller's own note before its meeting has ended", async () => {
			const s = await endedMeeting();
			const [live] = await testDb
				.insert(meetings)
				.values({
					clubId: s.clubId,
					scheduledAt: new Date(Date.now() - 10 * MIN),
					lengthMinutes: 90,
				})
				.returning({ id: meetings.id });
			const early = await note(
				s,
				s.memberId,
				"mid-meeting",
				live?.id as string,
			);
			const ended = await note(s, s.memberId, "after the end");

			// The same person, the same call: the ended meeting's note goes, the
			// live one does not — and answers like a note that never existed.
			expect(await deleteMyFeedbackNote(s.memberUserId, early)).toEqual({
				deleted: false,
			});
			expect(await exists(early)).toBe(true);
			expect(await deleteMyFeedbackNote(s.memberUserId, ended)).toEqual({
				deleted: true,
			});
			// And once that meeting HAS ended, on the server's clock, it can go.
			expect(
				await deleteMyFeedbackNote(
					s.memberUserId,
					early,
					new Date(Date.now() + 2 * 60 * MIN),
				),
			).toEqual({ deleted: true });
		});

		it("answers not-found for a malformed id", async () => {
			const s = await endedMeeting();
			expect(await deleteMyFeedbackNote(s.memberUserId, "nope")).toEqual({
				deleted: false,
			});
		});

		it("a person with memberships in two clubs deletes in both, archived included", async () => {
			const a = await endedMeeting();
			const b = await endedMeeting();
			const alsoInB = await addMember(b.clubId, "Member User", a.personId);
			const inA = await note(a, a.memberId, "from A");
			const inB = await note(b, alsoInB, "from B");
			// B's own member (a different person) is not the recipient of `inB`.
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, b.clubId));

			expect(texts(await loadFeedbackForUser(a.memberUserId)).sort()).toEqual([
				"from A",
				"from B",
			]);
			expect(await deleteMyFeedbackNote(b.memberUserId, inB)).toEqual({
				deleted: false,
			});
			expect(await deleteMyFeedbackNote(a.memberUserId, inB)).toEqual({
				deleted: true,
			});
			expect(await deleteMyFeedbackNote(a.memberUserId, inA)).toEqual({
				deleted: true,
			});
		});
	});

	describe("markMyFeedbackSeen", () => {
		it("marks the caller's notes seen, so the next read counts 0 unseen", async () => {
			const s = await endedMeeting();
			const a = await note(s, s.memberId, "one");
			const b = await note(s, s.memberId, "two");
			const before = await loadFeedbackForUser(s.memberUserId);
			expect(before.unseenCount).toBe(2);

			expect(await markMyFeedbackSeen(s.memberUserId, [a, b])).toEqual({
				marked: 2,
			});
			const after = await loadFeedbackForUser(s.memberUserId);
			expect(after.unseenCount).toBe(0);
			expect(texts(after).sort()).toEqual(["one", "two"]);
		});

		it("ignores someone else's note ids, a note not rendered, and an unreadable note", async () => {
			const s = await endedMeeting();
			const mine = await note(s, s.memberId, "mine");
			const notShown = await note(s, s.memberId, "arrived later");
			const theirs = await note(s, s.adminMemberId, "the admin's");
			const [future] = await testDb
				.insert(meetings)
				.values({ clubId: s.clubId, scheduledAt: new Date(Date.now() + DAY) })
				.returning({ id: meetings.id });
			const early = await note(
				s,
				s.memberId,
				"not yet readable",
				future?.id as string,
			);

			expect(
				await markMyFeedbackSeen(s.memberUserId, [mine, theirs, early]),
			).toEqual({ marked: 1 });
			expect(await seenAt([mine, notShown, theirs, early])).toEqual({
				[mine]: true,
				[notShown]: false,
				[theirs]: false,
				[early]: false,
			});
			// The owner can still mark theirs: the refusal was ownership.
			expect(await markMyFeedbackSeen(s.adminUserId, [theirs])).toEqual({
				marked: 1,
			});
		});

		it("marks nothing for an empty or malformed id list", async () => {
			const s = await endedMeeting();
			const mine = await note(s, s.memberId, "mine");
			expect(await markMyFeedbackSeen(s.memberUserId, [])).toEqual({
				marked: 0,
			});
			expect(await markMyFeedbackSeen(s.memberUserId, ["x"])).toEqual({
				marked: 0,
			});
			expect(await seenAt([mine])).toEqual({ [mine]: false });
		});
	});
});

describe("the recipient server fns take the recipient from the session (#986)", () => {
	const src = readFileSync(
		resolve(__dirname, "role-feedback.ts"),
		"utf8",
	).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
	const body = (name: string) => {
		const at = src.indexOf(`export const ${name} =`);
		expect(at, `${name} is declared`).toBeGreaterThan(-1);
		const next = src.indexOf("export const ", at + 1);
		return src.slice(at, next === -1 ? undefined : next);
	};

	it.each([
		["listMyFeedback", "loadFeedbackForUser(user.id)", "GET"],
		["deleteMyFeedback", "deleteMyFeedbackNote(user.id, data.noteId)", "POST"],
		[
			"markMyFeedbackSeen",
			"markMyFeedbackSeenLogic(user.id, data.noteIds)",
			"POST",
		],
	])("%s gates on requireUser and passes the session user's id", (name, call, method) => {
		const b = body(name);
		expect(b).toContain(`method: "${method}"`);
		expect(b).toMatch(/const user = await requireUser\(\);/);
		expect(b).toContain(call);
	});

	it("listMyFeedback logs a failed read on the server before it leaves", () => {
		const b = body("listMyFeedback");
		expect(b).toMatch(
			/try \{\s*return await loadFeedbackForUser\(user\.id\);\s*\} catch \(err\) \{\s*console\.error\([^)]*err\);\s*throw err;\s*\}/,
		);
	});

	it("no recipient input field: the inputs carry only a note id, or note ids", () => {
		expect(src).toMatch(
			/const deleteInput = z\.object\(\{ noteId: z\.string\(\)\.uuid\(\) \}\);/,
		);
		expect(src).not.toMatch(/(memberId|userId|recipient)\s*:\s*z\./i);
	});
});
