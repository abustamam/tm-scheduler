/**
 * #1658: a guest-book line whose name is close to a club guest or member, and
 * which does not resolve by contact, plans as `ambiguous` — the same rule
 * `record_attendance` applies to a `newGuest`. The public guest book keeps
 * creating a new guest for the same line.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetings } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	setMemberEmail,
	setMemberPhone,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { plan } = await import("#/server/guest-book-plan");
const { captureGuestVisit } = await import("#/server/guest-pipeline-logic");

describe.skipIf(!hasTestDb)("guest-book near-name ambiguity (#1658)", () => {
	let seed: SeededClub;
	let meetingDate: string;

	const club = () => ({ clubId: seed.clubId, timezone: "America/Chicago" });
	const run = (
		entries: { name: string; email?: string; phone?: string }[],
		resolve?: Record<string, string>,
	) => plan(testDb, club(), { meetingDate, entries, resolve }, "1");

	async function addGuest(name: string, email?: string) {
		const [row] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name, email, stage: "prospect" },
					testDb,
				),
			)
			.returning({ id: guests.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return row!.id;
	}

	beforeEach(async () => {
		seed = await seedClub();
		const weekAgo = utcToZonedWallTime(
			new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			"America/Chicago",
		).slice(0, 10);
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: zonedWallTimeToUtc(`${weekAgo}T12:00`, "America/Chicago"),
			status: "completed",
		});
		meetingDate = weekAgo;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("plans a near-name guest with a NEW email as ambiguous, listing that guest", async () => {
		const id = await addGuest("Imani Clarke", "imani@example.com");
		const r = await run([{ name: "Imani Clark", email: "other@example.com" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
		expect(r.blocking).toHaveLength(1);
		expect(r.blocking[0]).toMatchObject({
			code: "AMBIGUOUS_GUEST",
			entryIndex: 0,
		});
		const detail = r.blocking[0]?.detail as {
			reason: string;
			candidates: { guestId: string }[];
		};
		expect(detail.reason).toBe("near_name");
		expect(detail.candidates.map((c) => c.guestId)).toContain(id);
	});

	it("plans a near-name MEMBER with a new email as ambiguous, listing the member", async () => {
		// seedClub's members are "Admin User" and "Member User".
		const r = await run([{ name: "Admin Usr", email: "x@example.com" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
		const detail = r.blocking[0]?.detail as {
			candidates: { name: string }[];
		};
		expect(detail.candidates.map((c) => c.name)).toContain("Admin User");
	});

	it("still matches by email, not ambiguous", async () => {
		const id = await addGuest("Imani Clarke", "imani@example.com");
		const r = await run([{ name: "Imani Clark", email: "imani@example.com" }]);
		expect(r.blocking).toEqual([]);
		expect(r.plan?.entries[0]).toMatchObject({
			outcome: "matched",
			guestId: id,
			via: "email",
		});
	});

	it('settles the line as new when the answer is "new"', async () => {
		await addGuest("Imani Clarke", "imani@example.com");
		const r = await run([{ name: "Imani Clark", email: "other@example.com" }], {
			"0": "new",
		});
		expect(r.blocking).toEqual([]);
		expect(r.plan?.entries[0]?.outcome).toBe("new");
	});

	it("leaves an unrelated name as new", async () => {
		await addGuest("Imani Clarke");
		const r = await run([{ name: "Zed Quill", email: "zed@example.com" }]);
		expect(r.blocking).toEqual([]);
		expect(r.plan?.entries[0]?.outcome).toBe("new");
	});

	type Detail = {
		reason: string;
		candidates: (
			| { kind: "guest"; guestId: string; name: string }
			| { kind: "member"; memberId: string; name: string }
		)[];
	};

	it("lists a member matched by EMAIL only, whatever the name, as a member candidate", async () => {
		await setMemberEmail(seed.memberId, "shared@example.com");
		const r = await run([{ name: "Zed Quill", email: "Shared@Example.com" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
		const detail = r.blocking[0]?.detail as Detail;
		expect(detail.candidates).toMatchObject([
			{ kind: "member", memberId: seed.memberId },
		]);
	});

	it("lists a member matched by PHONE in another format as a member candidate", async () => {
		await setMemberPhone(seed.memberId, "(555) 123-4567");
		const r = await run([{ name: "Zed Quill", phone: "555.123.4567" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
		const detail = r.blocking[0]?.detail as Detail;
		expect(detail.candidates).toMatchObject([
			{ kind: "member", memberId: seed.memberId },
		]);
	});

	it("does not stay ambiguous for a different phone", async () => {
		await setMemberPhone(seed.memberId, "(555) 123-4567");
		const r = await run([{ name: "Zed Quill", phone: "555-999-0000" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("new");
	});

	it("refuses a member id as the answer to a line; it is not a guest", async () => {
		await setMemberEmail(seed.memberId, "shared@example.com");
		const r = await run([{ name: "Zed Quill", email: "shared@example.com" }], {
			"0": seed.memberId,
		});
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
		expect(r.blocking[0]?.message).toMatch(/not a guest of this club/);
	});

	it("never lists guests under a member-kind candidate or the reverse", async () => {
		const id = await addGuest("Admin Usher");
		const r = await run([{ name: "Admin Usr", email: "x@example.com" }]);
		const detail = r.blocking[0]?.detail as Detail;
		for (const c of detail.candidates) {
			if (c.kind === "guest") expect(c.guestId).toBe(id);
			else expect(c.memberId).toBe(seed.adminMemberId);
		}
		expect(detail.candidates.some((c) => c.kind === "guest")).toBe(true);
		expect(detail.candidates.some((c) => c.kind === "member")).toBe(true);
	});

	it("does not enumerate the roster for a punctuation-only or one-or-two-letter name", async () => {
		await addGuest("Al Smith");
		for (const name of ["!!!", "...", "A", "Al"]) {
			const r = await run([{ name, email: "fresh@example.com" }]);
			expect(r.blocking, name).toEqual([]);
			expect(r.plan?.entries[0]?.outcome, name).toBe("new");
		}
	});

	it("applies no name minimum to a contact match", async () => {
		await setMemberEmail(seed.memberId, "shared@example.com");
		const r = await run([{ name: "Al", email: "shared@example.com" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
	});

	it("caps the candidate list, guests first, while still deciding on the full list", async () => {
		for (const n of [
			"Imani One",
			"Imani Two",
			"Imani Three",
			"Imani Four",
			"Imani Five",
		]) {
			await addGuest(n);
		}
		const r = await run([{ name: "Imani", email: "fresh@example.com" }]);
		expect(r.plan?.entries[0]?.outcome).toBe("ambiguous");
		const detail = r.blocking[0]?.detail as Detail;
		expect(detail.candidates).toHaveLength(3);
		expect(detail.candidates.every((c) => c.kind === "guest")).toBe(true);
	});

	it("plans every near-name line on one page, each with its own candidates", async () => {
		await addGuest("Imani Clarke");
		await addGuest("Omar Haddad");
		const r = await run([
			{ name: "Imani Clark", email: "a@example.com" },
			{ name: "Zed Quill", email: "z@example.com" },
			{ name: "Omar Hadad", email: "b@example.com" },
		]);
		expect(r.plan?.entries.map((e) => e.outcome)).toEqual([
			"ambiguous",
			"new",
			"ambiguous",
		]);
		expect(r.blocking.map((b) => b.entryIndex)).toEqual([0, 2]);
		const names = r.blocking.map(
			(b) => (b.detail as Detail).candidates.map((c) => c.name)[0],
		);
		expect(names).toEqual(["Imani Clarke", "Omar Haddad"]);
	});

	it("keeps the public guest book creating a new guest for a near-name line", async () => {
		const id = await addGuest("Imani Clarke", "imani@example.com");
		const res = await captureGuestVisit({
			clubId: seed.clubId,
			name: "Imani Clark",
			email: "other@example.com",
			phone: null,
		});
		expect(res.created).toBe(true);
		expect(res.guestId).not.toBe(id);
		const rows = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(rows).toHaveLength(2);
	});
});
