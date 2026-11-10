/**
 * DB-backed tests for `record_table_topics` (#1575) and the `tableTopicsSpeakers`
 * field of `get_agenda`.
 *
 * Card: protects=a table topics list edited from the connector ends up exactly as
 * the preview promised, through the app's own cores, all steps or none;
 * fails_when=a preview writes, an apply produces a different list or order than
 * its preview, an ambiguous new guest is created unconfirmed, the wrong caller is
 * served, or get_agenda shows the list to a caller who may not see the roll;
 * no_claim=the authorization table (`delegate-authz`) and the web writers
 * (`minutes.integration.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
	apiTokens,
	guests,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { recordTableTopicsTool } = await import(
	"#/server/mcp/tools/record-table-topics"
);
const { getAgendaTool } = await import("#/server/mcp/tools/get-agenda");
const { hashApiToken } = await import("#/server/api-tokens-logic");

type Blocking = { code: string; entryIndex?: number; message: string };
type Line = {
	position: number;
	kind: string;
	name: string;
	topic: string | null;
};
type AddRow = {
	index: number;
	kind: string;
	name: string;
	verdict: string;
	confirmed: boolean;
};
type Preview = {
	applied: false;
	planHash: string;
	blocking: Blocking[];
	plan: {
		before: (Line & { id: string })[];
		adds: AddRow[];
		after: Line[];
	};
};
type Applied = {
	applied: true;
	tableTopicsSpeakers: (Line & { id: string })[];
};

describe.skipIf(!hasTestDb)("record_table_topics (#1575)", () => {
	let seed: SeededClub;
	let token: string;
	const extraClubs: SeededClub[] = [];

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	const call = (args: Record<string, unknown>, raw = token) =>
		recordTableTopicsTool.handler(args, { rawToken: raw });
	const preview = async (args: Record<string, unknown>, raw = token) =>
		(await call({ meetingId: seed.meetingId, ...args }, raw)) as Preview;
	const apply = async (args: Record<string, unknown>, raw = token) => {
		const p = await preview(args, raw);
		return (await call(
			{ meetingId: seed.meetingId, ...args, planHash: p.planHash },
			raw,
		)) as Applied;
	};

	async function outcome(p: Promise<unknown>) {
		try {
			return { ok: true as const, value: await p };
		} catch (err) {
			const e = err as { code?: string; message: string; detail?: unknown };
			return { ok: false as const, err, code: e.code, detail: e.detail };
		}
	}

	async function stored(meetingId = seed.meetingId) {
		return testDb
			.select()
			.from(tableTopicsSpeakers)
			.where(eq(tableTopicsSpeakers.meetingId, meetingId))
			.orderBy(asc(tableTopicsSpeakers.sortOrder), asc(tableTopicsSpeakers.id));
	}

	async function addMember(name: string): Promise<string> {
		const [person] = await testDb
			.insert(people)
			.values({ name })
			.returning({ id: people.id });
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: person!.id,
				name,
				status: "active",
			})
			.returning({ id: members.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return m!.id;
	}

	async function addGuest(name: string, clubId = seed.clubId): Promise<string> {
		const [g] = await testDb
			.insert(guests)
			.values(await withGuestPerson({ clubId, name }, testDb))
			.returning({ id: guests.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return g!.id;
	}

	async function giveRole(roleName: string, memberId: string) {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: roleName,
				category: "functionary",
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			roleDefinitionId: def!.id,
			assignedMemberId: memberId,
			status: "confirmed",
		});
	}

	const setStatus = (status: "completed" | "cancelled") =>
		testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, seed.meetingId));

	beforeEach(async () => {
		seed = await seedClub();
		token = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const c of extraClubs.splice(0)) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
	});

	it("a preview writes nothing and returns the list as it would be after the call", async () => {
		// protects=the preview is read-only, including a guest it would mint
		// fails_when=a speaker or guest row exists after a preview, or `after` is not the list an apply gives
		const p = await preview({
			add: [
				{ memberId: seed.memberId, topic: "Favourite food" },
				{ newGuest: { name: "Zebediah Quux" } },
			],
		});
		expect(p.plan.after.map((l) => [l.position, l.name, l.topic])).toEqual([
			[1, "Member User", "Favourite food"],
			[2, "Zebediah Quux", null],
		]);
		expect(await stored()).toHaveLength(0);
		const minted = await testDb
			.select()
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(minted).toHaveLength(0);
	});

	it("applies an add + remove + move in one call to exactly the previewed list", async () => {
		// protects=remove, then add, then move, on one transaction, in the order given
		// fails_when=the stored order differs from the preview's `after`
		const a = await addMember("Alice Adams");
		const b = await addMember("Bob Brown");
		const first = await apply({
			add: [{ memberId: a }, { memberId: b, topic: "Travel" }],
		});
		const [idA, idB] = first.tableTopicsSpeakers.map((r) => r.id) as [
			string,
			string,
		];
		const gid = await addGuest("Gina Guest");

		// After remove + add the list is [Bob, Gina, Member]; move Bob (an old row)
		// last. A row added in this call has no id yet, so it cannot be moved.
		const args = {
			remove: [idA],
			add: [{ guestId: gid, topic: "Pets" }, { memberId: seed.memberId }],
			move: [{ id: idB, toIndex: 2 }],
		};
		const p = await preview(args);
		expect(p.blocking).toEqual([]);
		expect(p.plan.after.map((l) => l.name)).toEqual([
			"Gina Guest",
			"Member User",
			"Bob Brown",
		]);
		const res = (await call({
			meetingId: seed.meetingId,
			...args,
			planHash: p.planHash,
		})) as Applied;
		expect(res.tableTopicsSpeakers.map((r) => r.name)).toEqual(
			p.plan.after.map((l) => l.name),
		);
		expect(res.tableTopicsSpeakers.map((r) => r.position)).toEqual([1, 2, 3]);
		expect((await stored()).map((r) => r.sortOrder)).toEqual([0, 1, 2]);
		expect(res.tableTopicsSpeakers[0]?.topic).toBe("Pets");
	});

	it("refuses an entry with both memberId and guestId, or with neither, at the schema", async () => {
		// protects=exactly one of memberId / guestId / newGuest per entry
		// fails_when=an ambiguous entry reaches the planner
		for (const entry of [
			{ memberId: seed.memberId, guestId: randomUUID() },
			{ topic: "only a topic" },
		]) {
			const r = await outcome(
				call({ meetingId: seed.meetingId, add: [entry] }),
			);
			expect(r.ok).toBe(false);
			expect(r.err).toBeInstanceOf(ZodError);
		}
		expect(await stored()).toHaveLength(0);
	});

	it("requires at least one list", async () => {
		const r = await outcome(call({ meetingId: seed.meetingId }));
		expect(r).toMatchObject({ ok: false, code: "VALIDATION" });
	});

	it("an ambiguous newGuest is skipped unless confirmed, and confirming changes the hash", async () => {
		// protects=the add_members rule: a name close to an existing person is never created on a guess
		// fails_when=the guest row is created unconfirmed, or a confirmation does not land / does not re-hash
		const existing = await addGuest("Jonathan Pike");
		const args = { add: [{ newGuest: { name: "Jon Pike" } }] };

		const p1 = await preview(args);
		expect(p1.plan.adds[0]).toMatchObject({
			verdict: "ambiguous",
			confirmed: false,
		});
		const res1 = (await call({
			meetingId: seed.meetingId,
			...args,
			planHash: p1.planHash,
		})) as Applied;
		expect(res1.tableTopicsSpeakers).toHaveLength(0);
		expect(await stored()).toHaveLength(0);
		const guestsNow = await testDb
			.select()
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(guestsNow.map((g) => g.id)).toEqual([existing]);

		// An old hash with confirmNew added is stale.
		const stale = await outcome(
			call({
				meetingId: seed.meetingId,
				...args,
				confirmNew: [0],
				planHash: p1.planHash,
			}),
		);
		expect(stale).toMatchObject({ ok: false, code: "PLAN_STALE" });

		const res2 = await apply({ ...args, confirmNew: [0] });
		expect(res2.tableTopicsSpeakers.map((r) => r.name)).toEqual(["Jon Pike"]);
		const after = await testDb
			.select()
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(after).toHaveLength(2);
	});

	it("a confirmNew index that is not a newGuest entry is refused", async () => {
		const r = await outcome(
			call({
				meetingId: seed.meetingId,
				add: [{ memberId: seed.memberId }],
				confirmNew: [0],
			}),
		);
		expect(r).toMatchObject({ ok: false, code: "VALIDATION" });
	});

	it("PLAN_STALE when the list changed between preview and apply, and nothing is written", async () => {
		const p = await preview({ add: [{ memberId: seed.memberId }] });
		await testDb.insert(tableTopicsSpeakers).values({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			sortOrder: 0,
		});
		const r = await outcome(
			call({
				meetingId: seed.meetingId,
				add: [{ memberId: seed.memberId }],
				planHash: p.planHash,
			}),
		);
		expect(r).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect(await stored()).toHaveLength(1);
	});

	it("an unknown remove id, a move past the end and a foreign member are refused, writing nothing", async () => {
		const foreign = await seedClub();
		extraClubs.push(foreign);
		const unknown = randomUUID();
		const bad = await preview({ remove: [unknown] });
		expect(bad.blocking.map((x) => x.code)).toEqual(["SLOT_NOT_IN_MEETING"]);
		expect(
			await outcome(
				call({
					meetingId: seed.meetingId,
					remove: [unknown],
					planHash: bad.planHash,
				}),
			),
		).toMatchObject({ ok: false, code: "BLOCKED" });
		await apply({ add: [{ memberId: seed.memberId }] });
		const past = await outcome(
			preview({
				move: [{ id: (await stored())[0]?.id as string, toIndex: 5 }],
			}),
		);
		expect(past).toMatchObject({ ok: false, code: "VALIDATION" });
		const p = await preview({ add: [{ memberId: foreign.memberId }] });
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
		const applied = await outcome(
			call({
				meetingId: seed.meetingId,
				add: [{ memberId: foreign.memberId }],
				planHash: p.planHash,
			}),
		);
		expect(applied).toMatchObject({ ok: false, code: "BLOCKED" });
		expect(await stored()).toHaveLength(1);
	});

	it.each([
		"Vote Counter",
		"Toastmaster of the Day",
	])("the meeting's %s succeeds through their own token", async (roleName) => {
		await giveRole(roleName, seed.memberId);
		const holder = await mintToken(seed.memberUserId);
		const res = await apply({ add: [{ memberId: seed.memberId }] }, holder);
		expect(res.tableTopicsSpeakers).toHaveLength(1);
	});

	it("an officer succeeds; a plain member and another meeting's Ballot Counter are refused", async () => {
		expect((await apply({ add: [{ memberId: seed.memberId }] })).applied).toBe(
			true,
		);
		const memberToken = await mintToken(seed.memberUserId);
		expect(
			await outcome(
				call(
					{ meetingId: seed.meetingId, add: [{ memberId: seed.memberId }] },
					memberToken,
				),
			),
		).toMatchObject({ ok: false, code: "FORBIDDEN" });

		// Ballot Counter of a DIFFERENT meeting of the same club.
		const [other] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Vote Counter",
				category: "functionary",
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			meetingId: other!.id,
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			roleDefinitionId: def!.id,
			assignedMemberId: seed.memberId,
			status: "confirmed",
		});
		expect(
			await outcome(
				call(
					{
						meetingId: seed.meetingId,
						add: [{ memberId: seed.adminMemberId }],
					},
					memberToken,
				),
			),
		).toMatchObject({ ok: false, code: "FORBIDDEN" });
		expect(await stored()).toHaveLength(1);
	});

	it("a completed meeting is accepted; a cancelled one is refused", async () => {
		await setStatus("completed");
		expect(
			(await apply({ add: [{ memberId: seed.memberId }] })).tableTopicsSpeakers,
		).toHaveLength(1);

		await setStatus("cancelled");
		const p = await preview({ add: [{ memberId: seed.adminMemberId }] });
		expect(p.blocking.map((b) => b.code)).toEqual(["MEETING_CANCELLED"]);
		const r = await outcome(
			call({
				meetingId: seed.meetingId,
				add: [{ memberId: seed.adminMemberId }],
				planHash: p.planHash,
			}),
		);
		expect(r).toMatchObject({ ok: false, code: "BLOCKED" });
		expect(await stored()).toHaveLength(1);
	});

	it("get_agenda returns the speakers with ids to an officer, and nothing to a plain member", async () => {
		// protects=the roll-derived list reaches only a caller who may see the roll (#1259)
		// fails_when=a plain member's get_agenda carries tableTopicsSpeakers
		const res = await apply({
			add: [{ memberId: seed.memberId, topic: "Weather" }],
		});
		const agenda = (await getAgendaTool.handler(
			{ meetingId: seed.meetingId },
			{ rawToken: token },
		)) as { tableTopicsSpeakers: (Line & { id: string })[] };
		expect(agenda.tableTopicsSpeakers).toEqual([
			{
				id: res.tableTopicsSpeakers[0]?.id,
				position: 1,
				memberId: seed.memberId,
				guestId: null,
				name: "Member User",
				topic: "Weather",
			},
		]);

		const memberToken = await mintToken(seed.memberUserId);
		const refused = await outcome(
			getAgendaTool.handler(
				{ meetingId: seed.meetingId },
				{ rawToken: memberToken },
			),
		);
		expect(refused.ok).toBe(false);
		expect(JSON.stringify(refused)).not.toContain("tableTopicsSpeakers");
	});
	describe("review round on #1590", () => {
		async function otherMeetingSpeaker(): Promise<{
			meetingId: string;
			id: string;
		}> {
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			const meetingId = m!.id;
			const [row] = await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId, memberId: seed.adminMemberId, sortOrder: 0 })
				.returning({ id: tableTopicsSpeakers.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			return { meetingId, id: row!.id };
		}

		it("a speaker id from ANOTHER meeting of the club is refused in remove and in move, writing to neither meeting", async () => {
			// protects=the id is scoped to the meeting named in the call, not just the club
			// fails_when=a foreign row is deleted or moved, or a row appears in either meeting
			const other = await otherMeetingSpeaker();
			await apply({ add: [{ memberId: seed.memberId }] });
			const mine = await stored();
			for (const args of [
				{ remove: [other.id] },
				{ move: [{ id: other.id, toIndex: 0 }] },
			]) {
				const p = await preview(args);
				expect(p.blocking.map((b) => b.code)).toEqual(["SLOT_NOT_IN_MEETING"]);
				expect(
					await outcome(
						call({ meetingId: seed.meetingId, ...args, planHash: p.planHash }),
					),
				).toMatchObject({ ok: false, code: "BLOCKED" });
			}
			expect(await stored()).toEqual(mine);
			expect(await stored(other.meetingId)).toHaveLength(1);
		});

		it("an id the preview listed and another writer deleted is PLAN_STALE, not VALIDATION", async () => {
			const a = await apply({ add: [{ memberId: seed.memberId }] });
			const id = a.tableTopicsSpeakers[0]?.id as string;
			const args = { remove: [id] };
			const p = await preview(args);
			await testDb
				.delete(tableTopicsSpeakers)
				.where(eq(tableTopicsSpeakers.id, id));
			expect(
				await outcome(
					call({ meetingId: seed.meetingId, ...args, planHash: p.planHash }),
				),
			).toMatchObject({ ok: false, code: "PLAN_STALE" });
		});

		it("two close newGuests in one add: the later is ambiguous against the earlier unless confirmed", async () => {
			const args = {
				add: [
					{ newGuest: { name: "Quentin Vale" } },
					{ newGuest: { name: "Q Vale" } },
				],
			};
			const p = await preview(args);
			expect(p.plan.adds.map((x) => x.verdict)).toEqual([
				"would_add",
				"ambiguous",
			]);
			const res = await apply(args);
			expect(res.tableTopicsSpeakers.map((r) => r.name)).toEqual([
				"Quentin Vale",
			]);
			// Not close: both land.
			const far = await apply({
				add: [
					{ newGuest: { name: "Orville Ng" } },
					{ newGuest: { name: "Pria Shah" } },
				],
			});
			expect(far.tableTopicsSpeakers.map((r) => r.name)).toEqual([
				"Quentin Vale",
				"Orville Ng",
				"Pria Shah",
			]);
		});

		it("an officer sees the names of close matches; a non-manager Ballot Counter sees only a count, in preview and apply", async () => {
			// protects=the preview cannot be used to list the club's past visitors or roster
			// fails_when=a guest or member name from the club shows up in a non-manager's output
			await addGuest("Zebediah Marlowe");
			await addMember("Zebediah Fenwick");
			await giveRole("Vote Counter", seed.memberId);
			const holder = await mintToken(seed.memberUserId);
			const args = { add: [{ newGuest: { name: "Zebediah" } }] };

			const asOfficer = await preview(args);
			expect(JSON.stringify(asOfficer)).toContain("Zebediah Marlowe");

			const asHolder = await preview(args, holder);
			const text = JSON.stringify(asHolder);
			expect(text).not.toContain("Marlowe");
			expect(text).not.toContain("Fenwick");
			expect(asHolder.plan.adds[0]).toMatchObject({
				verdict: "ambiguous",
				matchCount: 2,
				possibleMatches: [],
			});
			const applied = await call(
				{ meetingId: seed.meetingId, ...args, planHash: asHolder.planHash },
				holder,
			);
			const appliedText = JSON.stringify(applied);
			expect(appliedText).not.toContain("Marlowe");
			expect(appliedText).not.toContain("Fenwick");
			expect(await stored()).toHaveLength(0);
		});
	});
});
