/**
 * DB-backed tests for the guest-book confirm flow (#806).
 *
 * This is where the apply cases of `record-guest-book.integration.test.ts`
 * moved to. The mechanism is unchanged — plan, hash, re-plan under a lock,
 * refuse while anything blocks, execute the plan and not the input — so the
 * cases that matter are still the REFUSALS, and each asserts on the ROWS
 * afterwards rather than on a result that says ok.
 *
 * What is new is everything the link adds: only its creator may open it, it
 * expires, it can be edited before it is applied, and it applies exactly once.
 *
 * Every pending row here is created by calling the real MCP tool, so the two
 * halves of the flow are exercised against each other rather than against a
 * fixture that agrees with whichever half was written last.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/guest-book-confirm.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	guestBookPendingPlans,
	guests,
	meetingAttendance,
	meetings,
	members,
} from "#/db/schema";
import { PENDING_PLAN_GRACE_MS } from "#/lib/guest-book-pending";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { recordGuestBookTool } = await import(
	"#/server/mcp/tools/record-guest-book"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const {
	applyPendingPlan,
	loadPendingPlan,
	patchPendingPlan,
	sweepExpiredPendingPlans,
} = await import("#/server/guest-book-pending-logic");

type View = Awaited<ReturnType<typeof loadPendingPlan>>;

/** Narrow to the editable state, failing loudly with what came back instead. */
function editable(view: View) {
	if (view.status !== "editable") {
		throw new Error(`expected an editable plan, got ${view.status}`);
	}
	return view;
}

describe.skipIf(!hasTestDb)("the guest-book confirm page (#806)", () => {
	let seed: SeededClub;
	let token: string;
	let pastMeetingId: string;
	let pastMeetingDate: string;

	/** Preview through the real tool, returning the pending id. */
	async function preview(
		entries: Record<string, unknown>[],
		meetingDate = pastMeetingDate,
	): Promise<string> {
		const result = (await recordGuestBookTool.handler(
			{ clubId: seed.clubId, meetingDate, entries },
			{ rawToken: token },
		)) as { pendingId: string };
		return result.pendingId;
	}

	function load(pendingId: string, userId = seed.adminUserId) {
		return loadPendingPlan({ pendingId, userId });
	}

	async function rows() {
		const g = await testDb
			.select({ id: guests.id, name: guests.name, email: guests.email })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		const a = await testDb
			.select({ guestId: meetingAttendance.guestId })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, pastMeetingId));
		return { guests: g, attendance: a };
	}

	beforeEach(async () => {
		seed = await seedClub();
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;

		// Midday club-local a week back — see the note in the MCP suite for why
		// the time of day is anchored rather than taken from the clock.
		const { utcToZonedWallTime, zonedWallTimeToUtc } = await import(
			"#/lib/datetime"
		);
		const weekAgo = utcToZonedWallTime(
			new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			"America/Chicago",
		).slice(0, 10);
		const past = zonedWallTimeToUtc(`${weekAgo}T12:00`, "America/Chicago");
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: past,
				status: "completed",
				theme: "Harvest",
			})
			.returning({ id: meetings.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		pastMeetingId = row!.id;
		pastMeetingDate = utcToZonedWallTime(past, "America/Chicago").slice(0, 10);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// --- AC4: the creator sees the real values ----------------------------

	it("renders every field unmasked, including an ambiguity's candidates", async () => {
		// The whole point of the page. A masked email cannot be checked against
		// the paper, and on an ambiguous line it is often the ONLY thing telling
		// two guests with the same name apart.
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Samir Patel",
			phone: "+15551234567",
			email: "samir@example.com",
			stage: "prospect",
		});
		const id = await preview([
			{ name: "Vera Real", email: "vera@example.com", phone: "+15559876543" },
			{ name: "Priya Raman", phone: "+1 555 123 4567" },
		]);

		const view = editable(await load(id));
		expect(view.entries[0]).toMatchObject({
			name: "Vera Real",
			email: "vera@example.com",
			phone: "+15559876543",
		});
		const ambiguity = view.blocking.find((b) => b.code === "AMBIGUOUS_GUEST");
		expect(ambiguity?.entryId).toBe(view.entries[1]?.id);
		expect(ambiguity?.candidates).toEqual([
			expect.objectContaining({
				name: "Samir Patel",
				email: "samir@example.com",
				phone: "+15551234567",
			}),
		]);
		// Nothing here is masked. Asserted on the serialized view, so a mask
		// slipping into any field of it fails.
		expect(JSON.stringify(view)).not.toContain("•••");
	});

	// --- AC5: creator-only ------------------------------------------------

	it("is not found for anyone but its creator, including another admin", async () => {
		const id = await preview([{ name: "Private Visitor", email: "p@x.com" }]);

		// A full admin of the same club, and still not their page to read.
		await testDb
			.update(members)
			.set({ clubRole: "admin" })
			.where(eq(members.id, seed.memberId));

		const other = await load(id, seed.memberUserId);
		expect(other).toEqual({ status: "not_found" });
		expect(JSON.stringify(other)).not.toContain("p@x.com");
		expect(JSON.stringify(other)).not.toContain("Private Visitor");

		// And an unknown id is the same answer, so nothing can be enumerated.
		expect(await load(randomUUID())).toEqual({ status: "not_found" });
	});

	it("is not found once the creator is no longer an admin of the club", async () => {
		// A pending row must not outlive the standing that made it.
		const id = await preview([{ name: "Left Behind" }]);
		expect((await load(id)).status).toBe("editable");

		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.adminMemberId));
		expect(await load(id)).toEqual({ status: "not_found" });
	});

	// --- AC15: the archive gate on the READ path --------------------------

	it("refuses the page and its PATCH once the club is archived", async () => {
		const id = await preview([{ name: "Taken Down", email: "td@x.com" }]);
		const before = editable(await load(id));
		const entryId = before.entries[0]?.id as string;

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));

		// `SESSION_GUARDS` drops a `requireUser`-bearing server fn from the
		// archive sweep entirely, so nothing but this case can see the gate.
		const view = await load(id);
		expect(view.status).toBe("archived");
		expect(JSON.stringify(view)).not.toContain("td@x.com");

		const patched = await patchPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			edit: { kind: "field", id: entryId, field: "name", value: "Renamed" },
		});
		expect(patched.status).toBe("archived");

		// And the edit did not land: a refused PATCH must not have written.
		const [stored] = await testDb
			.select({ entries: guestBookPendingPlans.entries })
			.from(guestBookPendingPlans)
			.where(eq(guestBookPendingPlans.id, id));
		expect(stored?.entries?.[0]?.name).toBe("Taken Down");

		// Archiving is reversible, so put it back before cleanup cascades.
		await testDb
			.update(clubs)
			.set({ archivedAt: null })
			.where(eq(clubs.id, seed.clubId));
	});

	// --- AC7: edits survive, and the index map holds ----------------------

	it("persists an edit and hands back a FRESH planHash", async () => {
		const id = await preview([{ name: "Typo Nmae", email: "typo@x.com" }]);
		const before = editable(await load(id));
		const entryId = before.entries[0]?.id as string;

		const after = editable(
			await patchPendingPlan({
				pendingId: id,
				userId: seed.adminUserId,
				edit: { kind: "field", id: entryId, field: "name", value: "Typo Name" },
			}),
		);
		expect(after.entries[0]?.name).toBe("Typo Name");
		// Without a fresh hash every apply after an edit would refuse as stale.
		expect(after.planHash).not.toBe(before.planHash);

		// Survives a reload: the edit is in the row, not in the page.
		expect(editable(await load(id)).entries[0]?.name).toBe("Typo Name");
	});

	it("drops the first of three lines and still maps blocking items to the right rows", async () => {
		// THE index-map case. `plan()` numbers the lines it is HANDED, so dropping
		// the first one renumbers the rest — and the two remaining problems would
		// be pinned to the wrong rows by anything that assumed the stored list and
		// the planned list line up.
		const id = await preview([
			{ name: "Fine Line", email: "fine@example.com" },
			{ name: "Bad Email", email: "not an address" },
			{ name: "Bad Phone", phone: "no digits here" },
		]);
		const before = editable(await load(id));
		const [first, second, third] = before.entries;

		const after = editable(
			await patchPendingPlan({
				pendingId: id,
				userId: seed.adminUserId,
				edit: { kind: "dropped", id: first?.id as string, dropped: true },
			}),
		);

		// All three rows are still stored — a drop is reversible.
		expect(after.entries).toHaveLength(3);
		expect(after.entries[0]?.dropped).toBe(true);
		// The dropped row has no outcome; the planner never saw it.
		expect(after.lines[0]).toMatchObject({ entryId: first?.id, outcome: null });

		const emailProblem = after.blocking.find((b) => b.code === "INVALID_EMAIL");
		const phoneProblem = after.blocking.find((b) => b.code === "INVALID_PHONE");
		expect(emailProblem?.entryId).toBe(second?.id);
		expect(phoneProblem?.entryId).toBe(third?.id);

		// Restoring puts it back in the plan.
		const restored = editable(
			await patchPendingPlan({
				pendingId: id,
				userId: seed.adminUserId,
				edit: { kind: "dropped", id: first?.id as string, dropped: false },
			}),
		);
		expect(restored.lines[0]?.outcome).toBe("new");
	});

	it("resolves an ambiguity from the page and applies it", async () => {
		const [existing] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Samir Patel",
				phone: "+15551234567",
				stage: "prospect",
			})
			.returning({ id: guests.id });
		// A shared number under a name that does not agree: #488 says these are
		// two prospects, and a transcriber gets asked rather than guessed at.
		const id = await preview([
			{ name: "Priya Raman", phone: "+1 555 123 4567" },
		]);

		const before = editable(await load(id));
		expect(before.blocking).toHaveLength(1);

		const answered = editable(
			await patchPendingPlan({
				pendingId: id,
				userId: seed.adminUserId,
				edit: {
					kind: "resolve",
					id: before.entries[0]?.id as string,
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					resolve: { kind: "existing", guestId: existing!.id },
				},
			}),
		);
		expect(answered.blocking).toEqual([]);
		expect(answered.lines[0]?.outcome).toBe("matched");

		const applied = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: answered.planHash,
		});
		expect(applied.ok).toBe(true);
		// Resolved onto the existing row: no second guest.
		const after = await rows();
		expect(after.guests).toHaveLength(1);
		expect(after.attendance).toHaveLength(1);
	});

	// --- the happy path, and AC13 -----------------------------------------

	it("applies a page: creates new guests, reuses matched ones, records attendance", async () => {
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Rita Vance",
			email: "rita@example.com",
			stage: "prospect",
		});
		const id = await preview([
			{ name: "Rita Vance", email: "rita@example.com" },
			{ name: "Newcomer One", email: "new1@example.com" },
		]);
		const view = editable(await load(id));

		const result = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});

		expect(result.ok).toBe(true);
		expect(result.applied?.newGuestIds).toHaveLength(1);
		expect(result.applied?.matchedGuestIds).toHaveLength(1);
		expect(result.applied?.attendanceRecorded).toBe(2);
		const after = await rows();
		expect(after.guests).toHaveLength(2);
		expect(after.attendance).toHaveLength(2);

		// AC13: exactly one activity row, crediting the confirming member, ids
		// only — every member of the club can read the feed.
		const log = await testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "guest_visits_record"),
				),
			);
		expect(log).toHaveLength(1);
		expect(log[0]?.actorMemberId).toBe(seed.adminMemberId);
		expect(JSON.stringify(log[0]?.detail)).not.toContain("Rita");
		expect(JSON.stringify(log[0]?.detail)).not.toContain("@example.com");
		// `mcp` would name something that is no longer true: the transcription
		// came from a token, the WRITE is this admin's session action.
		expect(log[0]?.detail).toMatchObject({ via: "guest-book-confirm" });
	});

	// --- AC10: the tombstone ----------------------------------------------

	it("sets applied_at, nulls entries, and re-renders as already-applied", async () => {
		const id = await preview([
			{ name: "Wanda Visitor", email: "wanda@example.com" },
		]);
		const view = editable(await load(id));
		await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});

		const [stored] = await testDb
			.select({
				entries: guestBookPendingPlans.entries,
				appliedAt: guestBookPendingPlans.appliedAt,
			})
			.from(guestBookPendingPlans)
			.where(eq(guestBookPendingPlans.id, id));
		expect(stored?.appliedAt).not.toBeNull();
		// No visitor contact details at rest once the write they justified landed.
		expect(stored?.entries).toBeNull();

		const reopened = await load(id);
		expect(reopened.status).toBe("applied");
		expect(JSON.stringify(reopened)).not.toContain("wanda@example.com");
		expect(JSON.stringify(reopened)).not.toContain("Wanda");
	});

	// --- AC14: applied once -----------------------------------------------

	it("refuses a second apply and writes nothing the second time", async () => {
		const id = await preview([
			{ name: "Once Only", email: "once@example.com" },
		]);
		const view = editable(await load(id));
		const first = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		expect(first.ok).toBe(true);
		const afterFirst = await rows();

		const second = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		expect(second.ok).toBe(false);
		expect(second.message).toMatch(/already been recorded/i);
		expect(second.view.status).toBe("applied");

		const afterSecond = await rows();
		expect(afterSecond.guests).toHaveLength(afterFirst.guests.length);
		expect(afterSecond.attendance).toHaveLength(afterFirst.attendance.length);
	});

	// --- AC8: a stale plan ------------------------------------------------

	it("refuses a stale plan, renders a fresh one, and writes nothing", async () => {
		const id = await preview([
			{ name: "Rita Vance", email: "rita@example.com" },
		]);
		const view = editable(await load(id));

		// Someone else records that same guest between render and click — the line
		// is now `already_present`, so the plan the human approved is no longer
		// the plan that would run.
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Rita Vance",
				email: "rita@example.com",
				stage: "prospect",
			})
			.returning({ id: guests.id });
		await testDb.insert(meetingAttendance).values({
			meetingId: pastMeetingId,
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			guestId: g!.id,
			status: "present",
		});

		const result = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/changed since/i);
		// A fresh plan comes back beside the refusal, so the page can show what
		// moved rather than making the reader reload.
		const refreshed = editable(result.view);
		expect(refreshed.planHash).not.toBe(view.planHash);
		expect(refreshed.lines[0]?.outcome).toBe("already_present");

		// Exactly the rows the interloper wrote — the apply added none.
		const after = await rows();
		expect(after.guests).toHaveLength(1);
		expect(after.attendance).toHaveLength(1);
	});

	// --- AC9: blocked ------------------------------------------------------

	it("refuses while a line still blocks, and writes nothing", async () => {
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Samir Patel",
			phone: "+15551234567",
			stage: "prospect",
		});
		const id = await preview([
			{ name: "Priya Raman", phone: "+1 555 123 4567" },
		]);
		const view = editable(await load(id));
		expect(view.blocking).toHaveLength(1);

		const result = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/need an answer/i);

		const after = await rows();
		expect(after.guests).toHaveLength(1);
		expect(after.attendance).toHaveLength(0);
	});

	it("refuses a page whose every line has been dropped", async () => {
		const id = await preview([{ name: "Only Line" }]);
		const before = editable(await load(id));
		const dropped = editable(
			await patchPendingPlan({
				pendingId: id,
				userId: seed.adminUserId,
				edit: {
					kind: "dropped",
					id: before.entries[0]?.id as string,
					dropped: true,
				},
			}),
		);

		const result = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: dropped.planHash,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/nothing to record/i);
		expect((await rows()).guests).toHaveLength(0);
	});

	// --- the same page twice, and one visitor named twice ------------------

	it("is a no-op on a second transcription of the same page", async () => {
		const entries = [
			{ name: "First Timer", email: "first@example.com" },
			{ name: "Second Timer", email: "second@example.com" },
		];
		const first = await preview(entries);
		await applyPendingPlan({
			pendingId: first,
			userId: seed.adminUserId,
			planHash: editable(await load(first)).planHash,
		});
		expect((await rows()).guests).toHaveLength(2);

		const second = await preview(entries);
		const view = editable(await load(second));
		expect(view.lines.every((l) => l.outcome === "already_present")).toBe(true);
		expect(view.summary).toMatchObject({
			already_present: 2,
			minutesRecipients: 0,
			// Worth saying: the apply would otherwise succeed while writing
			// nothing and look like it worked.
			probablyAlreadyTranscribed: true,
		});

		await applyPendingPlan({
			pendingId: second,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		const after = await rows();
		expect(after.guests).toHaveLength(2);
		expect(after.attendance).toHaveLength(2);
	});

	it("creates ONE guest when a page names the same visitor twice", async () => {
		const id = await preview([
			{ name: "Dup Visitor", email: "dup@example.com" },
			{ name: "Dup Visitor", email: "dup@example.com" },
		]);
		const view = editable(await load(id));
		expect(view.lines.map((l) => l.outcome)).toEqual([
			"new",
			"already_present",
		]);
		await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		const after = await rows();
		expect(after.guests).toHaveLength(1);
		expect(after.attendance).toHaveLength(1);
	});

	// --- AC16: an McpError becomes a page state ---------------------------

	it("renders a blocked state for a meeting that has not happened yet", async () => {
		// `plan()` THROWS `NOT_RECORDABLE` here, and this page re-plans through
		// the same function — so the error has to become a page state. Letting one
		// escape would surface as a route error boundary on the URL whose whole
		// job is to explain what is wrong.
		//
		// The row is INSERTED rather than previewed, and that is the honest way to
		// reach this: preview throws on a future meeting and stores nothing, so no
		// sequence of tool calls produces a pending row in this state. It is
		// reachable all the same, because the date is re-resolved against live
		// data on every render — a club's timezone edit, or a meeting moved to
		// later on the same club-local day, both land here — and a page state that
		// can be reached by any path at all has to be the state rather than a 500.
		const { utcToZonedWallTime } = await import("#/lib/datetime");
		// +11 days, clear of `seedClub`'s own future meeting — two meetings on
		// one date would make this AMBIGUOUS_DATE instead, which is a different case.
		const soon = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
		const futureDate = utcToZonedWallTime(soon, "America/Chicago").slice(0, 10);
		await testDb
			.insert(meetings)
			.values({ clubId: seed.clubId, scheduledAt: soon, status: "scheduled" });
		const [row] = await testDb
			.insert(guestBookPendingPlans)
			.values({
				clubId: seed.clubId,
				meetingDate: futureDate,
				createdByUserId: seed.adminUserId,
				entries: [{ id: "e1", name: "Too Early" }],
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			})
			.returning({ id: guestBookPendingPlans.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		const id = row!.id;

		const view = await load(id);
		expect(view).toMatchObject({
			status: "unplannable",
			reason: "NOT_RECORDABLE",
		});

		// And it cannot apply either.
		const result = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: "whatever",
		});
		expect(result.ok).toBe(false);
		expect((await rows()).guests).toHaveLength(0);
	});

	it("renders a blocked state when the meeting is moved off the date entirely", async () => {
		// The reachable sibling of the case above: a meeting rescheduled to
		// another day leaves the stored date naming nothing.
		const id = await preview([{ name: "Rescheduled" }]);
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, pastMeetingId));

		expect(await load(id)).toMatchObject({
			status: "unplannable",
			reason: "NO_MEETING_ON_DATE",
		});
	});

	it("renders a blocked state when the date names no meeting", async () => {
		const id = await preview([{ name: "Nowhere" }], "2001-01-01");
		expect(await load(id)).toMatchObject({
			status: "unplannable",
			reason: "NO_MEETING_ON_DATE",
		});
	});

	// --- AC11 / AC12: expiry and the sweep --------------------------------

	it("renders an expired state inside the grace window, and will not apply", async () => {
		const id = await preview([{ name: "Too Late", email: "late@example.com" }]);
		const view = editable(await load(id));

		// One minute past the deadline: expired, but well inside the grace window
		// the sweep respects.
		await testDb
			.update(guestBookPendingPlans)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(guestBookPendingPlans.id, id));

		expect((await load(id)).status).toBe("expired");
		const result = await applyPendingPlan({
			pendingId: id,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/expired/i);
		expect((await rows()).guests).toHaveLength(0);
	});

	it("sweeps rows past the grace window and leaves rows inside it", async () => {
		const inside = await preview([{ name: "Recently Expired" }]);
		const outside = await preview([{ name: "Long Gone" }]);
		const applied = await preview([{ name: "Done With" }]);

		const now = Date.now();
		// Expired, inside the grace window: still renders an explanation.
		await testDb
			.update(guestBookPendingPlans)
			.set({ expiresAt: new Date(now - 60_000) })
			.where(eq(guestBookPendingPlans.id, inside));
		// Past it, unapplied.
		await testDb
			.update(guestBookPendingPlans)
			.set({ expiresAt: new Date(now - PENDING_PLAN_GRACE_MS - 60_000) })
			.where(eq(guestBookPendingPlans.id, outside));
		// Past it, applied — a tombstone is swept on the same rule.
		await testDb
			.update(guestBookPendingPlans)
			.set({
				expiresAt: new Date(now - PENDING_PLAN_GRACE_MS - 60_000),
				appliedAt: new Date(now),
				entries: null,
			})
			.where(eq(guestBookPendingPlans.id, applied));

		await sweepExpiredPendingPlans();

		const left = await testDb
			.select({ id: guestBookPendingPlans.id })
			.from(guestBookPendingPlans)
			.where(eq(guestBookPendingPlans.clubId, seed.clubId));
		expect(left.map((r) => r.id)).toEqual([inside]);
		// The row inside the window still explains itself, which is what stops
		// AC11 and AC12 racing.
		expect((await load(inside)).status).toBe("expired");
	});
});
