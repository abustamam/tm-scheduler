/**
 * The Easy-Speak import plan reads the member list, the mentor chart and the
 * speech requesters as people too (#1203), against the test database. Each test
 * is an acceptance criterion of the issue.
 *
 * Run with:
 *   bunx vitest run src/server/history-import-list-people.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, count, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	importRefs,
	meetings,
	members,
	mentorships,
	people,
	roleSlots,
	speechRequests,
	user,
} from "#/db/schema";
import type { EasySpeakBundleV1 } from "#/lib/easy-speak-bundle";
import type {
	ImportPlan,
	PersonResolution,
	PlanPerson,
} from "#/lib/easy-speak-import-plan";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./history-import-logic");
const mentorLogic = await import("./mentor-import-logic");

const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");

/** The fixture's meeting people; Avery Alderfinch is left off, the two Dovecotts are ambiguous. */
const MEETING_ROSTER = [
	"Elliot Tansley",
	"Zéphyr Ashlowe",
	"Elliot Dovecott",
	"Elliot Dovecott",
	"Parker Vexford",
	"Zephyr Ironvale",
	"Jules Valewood",
	"Kai Larkspur",
	"Wren Mistlewood",
	"Umber Yarrowby",
	"Dana Vexford",
	"Casey Foxglade",
	"Blair Yarrowby",
	"Morgan Ravenscar",
	"Lane Stonebrook",
];

const NOVA = { esUserId: "900200", name: "Nova Quill" };
const ORLA = { esUserId: "900201", name: "Orla Vale" };
const GHOST = { esUserId: "900202", name: "Ghost Pepper" };

/**
 * The fixture with its lists replaced. Nova (a mentee) and Orla (her mentor) are
 * named by the mentor chart and Nova's request only. Ghost is on the member list,
 * in the chart and in the requests, and is on no roster.
 */
function bundleText(): string {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
	bundle.people = [
		...bundle.people,
		{ ...GHOST, status: "Member", joined: null },
	];
	bundle.mentors = [
		{ mentee: NOVA, mentor: ORLA, wantsMentee: false },
		{ mentee: GHOST, mentor: ORLA, wantsMentee: false },
	];
	const request = (who: typeof NOVA, esSpeechId: string) => ({
		esSpeechId,
		who,
		title: "An Icebreaker",
		path: null,
		project: null,
		introduction: null,
		requestedOn: "2026-05-01",
		preferred: [null, null, null],
		scheduledOn: null,
		status: "requested",
	});
	bundle.speechRequests = [
		request(NOVA, "sr-nova"),
		request(GHOST, "sr-ghost"),
	];
	return JSON.stringify(bundle);
}

describe.skipIf(!hasTestDb)(
	"import plan: member list, mentor chart and requesters (#1203)",
	() => {
		let seed: SeededClub;
		let superadminId: string;
		const extraUsers: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			superadminId = randomUUID();
			await testDb.insert(user).values({
				id: superadminId,
				name: "Super",
				email: `super-${superadminId}@test.example`,
				emailVerified: true,
				isSuperadmin: true,
			});
			extraUsers.push(superadminId);
			await testDb
				.update(clubs)
				.set({ timezone: "America/Los_Angeles" })
				.where(eq(clubs.id, seed.clubId));
			for (const name of MEETING_ROSTER) await addMember(name);
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			await testDb.delete(user).where(inArray(user.id, extraUsers.splice(0)));
		});

		async function addMember(name: string): Promise<string> {
			const [person] = await testDb
				.insert(people)
				.values({ name })
				.returning({ id: people.id });
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person?.id as string,
					name,
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			return member?.id as string;
		}

		const upload = () =>
			logic.storeEasySpeakBundle({
				clubId: seed.clubId,
				uploadedByUserId: superadminId,
				text: bundleText(),
			});

		/** What a superadmin answers: the Dovecotts are one member, anyone else a meeting names is a guest. */
		async function answers(importId: string) {
			const preview = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId,
				now: NOW,
			});
			const dovecott = preview.roster.find((m) => m.name === "Elliot Dovecott")
				?.memberId as string;
			const resolutions: Record<string, PersonResolution> = {};
			for (const p of preview.people) {
				if (!p.needsDecision) continue;
				resolutions[p.key] =
					p.status === "ambiguous"
						? { action: "member", memberId: dovecott }
						: { action: "guest", kind: "visitor" };
			}
			return { preview, resolutions };
		}

		const apply = (
			importId: string,
			resolutions: Record<string, PersonResolution>,
		) =>
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId,
				superadminUserId: superadminId,
				resolutions,
				now: NOW,
			});

		const personRef = async (esUserId: string) => {
			const [row] = await testDb
				.select({ targetId: importRefs.targetId })
				.from(importRefs)
				.where(
					and(
						eq(importRefs.clubId, seed.clubId),
						eq(importRefs.kind, "person"),
						eq(importRefs.sourceId, `es:${esUserId}`),
					),
				);
			return row?.targetId ?? null;
		};

		const n = async (table: typeof guests | typeof meetings) => {
			const [row] = await testDb
				.select({ n: count() })
				.from(table)
				.where(eq(table.clubId, seed.clubId));
			return Number(row?.n ?? 0);
		};

		/** Every row an apply may write, and the refs by kind. */
		async function snapshot() {
			const refs = await testDb
				.select({ kind: importRefs.kind, sourceId: importRefs.sourceId })
				.from(importRefs)
				.where(eq(importRefs.clubId, seed.clubId));
			const meetingIds = (
				await testDb
					.select({ id: meetings.id })
					.from(meetings)
					.where(eq(meetings.clubId, seed.clubId))
			).map((m) => m.id);
			const [slots] = await testDb
				.select({ n: count() })
				.from(roleSlots)
				.where(inArray(roleSlots.meetingId, meetingIds));
			const [memberCount] = await testDb
				.select({ n: count() })
				.from(members)
				.where(eq(members.clubId, seed.clubId));
			return {
				guests: await n(guests),
				meetings: await n(meetings),
				members: Number(memberCount?.n ?? 0),
				roleSlots: Number(slots?.n ?? 0),
				refs: refs.map((r) => `${r.kind}|${r.sourceId}`).sort(),
			};
		}

		it("AC1: a member only the chart and the requests name gets a person ref, and both later steps import their rows", async () => {
			const nova = await addMember(NOVA.name);
			const orla = await addMember(ORLA.name);
			const stored = await upload();
			const { preview, resolutions } = await answers(stored.importId);

			const novaPlan = preview.people.find((p) => p.key === "es:900200");
			expect(novaPlan).toMatchObject({
				listOnly: true,
				status: "member",
				via: "exact",
				memberId: nova,
				needsDecision: false,
			});
			expect(novaPlan?.appearances).toMatchObject({
				mentorChart: 1,
				speechRequests: 1,
				memberList: 0,
			});

			await apply(stored.importId, resolutions);
			expect(await personRef(NOVA.esUserId)).toBe(nova);
			expect(await personRef(ORLA.esUserId)).toBe(orla);

			const mentored = await mentorLogic.importMentorPairs({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			// Nova's pair, and Ghost Pepper's: she is on the member list, so the apply
			// made her a member (#1240).
			expect(mentored.imported).toBe(2);
			const pairs = await testDb
				.select()
				.from(mentorships)
				.where(eq(mentorships.clubId, seed.clubId));
			expect(
				pairs.map((p) => [p.mentorMemberId, p.menteeMemberId]),
			).toContainEqual([orla, nova]);

			const requested = await logic.importSpeechRequests({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			expect(requested.imported).toBe(2);
			const rows = await testDb
				.select({ membershipId: speechRequests.membershipId })
				.from(speechRequests)
				.where(eq(speechRequests.clubId, seed.clubId));
			expect(rows).toContainEqual({ membershipId: nova });
		});

		it("AC2: a member-list-only person who matches nobody is made a member, so the later steps find them (#1240)", async () => {
			await addMember(NOVA.name);
			await addMember(ORLA.name);
			const stored = await upload();
			const { preview, resolutions } = await answers(stored.importId);

			expect(preview.people.find((p) => p.key === "es:900202")).toMatchObject({
				listOnly: true,
				status: "create",
				needsDecision: false,
			});
			// Not a decision: it does not block, and no answer is asked for.
			expect(resolutions["es:900202"]).toBeUndefined();

			const before = await snapshot();
			await apply(stored.importId, resolutions);

			const [ghost] = await testDb
				.select({ id: members.id, status: members.status })
				.from(members)
				.where(
					and(eq(members.clubId, seed.clubId), eq(members.name, GHOST.name)),
				);
			expect(ghost?.status).toBe("active");
			expect(await personRef(GHOST.esUserId)).toBe(ghost?.id);
			// The members made are the meetings' own former members and the list's.
			expect((await snapshot()).members).toBeGreaterThan(before.members);

			const mentored = await mentorLogic.importMentorPairs({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			expect(mentored.skipped).toEqual([]);
			expect(mentored.imported).toBe(2);
			const requested = await logic.importSpeechRequests({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			expect(requested).toMatchObject({ imported: 2, skippedNoMember: 0 });
		});

		it("AC3: an ambiguous list-only name asks the decision a meeting's would, and blocks until it is answered", async () => {
			await addMember(NOVA.name);
			const orla = await addMember(ORLA.name);
			await addMember(ORLA.name);
			const stored = await upload();
			const { preview, resolutions } = await answers(stored.importId);

			const orlaPlan = preview.people.find((p) => p.key === "es:900201");
			expect(orlaPlan).toMatchObject({
				listOnly: true,
				status: "ambiguous",
				needsDecision: true,
			});
			expect(orlaPlan?.candidates).toHaveLength(2);
			// Leave her unanswered (`answers` picked a member for her): apply refuses.
			delete resolutions["es:900201"];
			await expect(apply(stored.importId, resolutions)).rejects.toThrow(
				logic.UNRESOLVED_PEOPLE_MESSAGE(1),
			);
			expect(await personRef(NOVA.esUserId)).toBeNull();

			// A guest is not on offer for a person no meeting names: the answer is
			// read as no answer.
			const asGuest = await logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				resolutions: {
					...resolutions,
					"es:900201": { action: "guest", kind: "visitor" },
				},
				now: NOW,
			});
			expect(asGuest.people.find((p) => p.key === "es:900201")?.status).toBe(
				"ambiguous",
			);
			expect(asGuest.canApply).toBe(false);

			await apply(stored.importId, {
				...resolutions,
				"es:900201": { action: "member", memberId: orla },
			});
			expect(await personRef(ORLA.esUserId)).toBe(orla);
		});

		it("AC4: re-applying an applied import adds the new refs and duplicates nothing", async () => {
			const stored = await upload();
			const { resolutions } = await answers(stored.importId);
			// First apply: Nova and Orla are not on the roster yet.
			await apply(stored.importId, resolutions);
			expect(await personRef(NOVA.esUserId)).toBeNull();
			const mentoredEarly = await mentorLogic.importMentorPairs({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			expect(mentoredEarly.imported).toBe(0);

			// They join; the same import is applied again.
			const nova = await addMember(NOVA.name);
			const orla = await addMember(ORLA.name);
			const before = await snapshot();
			await apply(stored.importId, resolutions);
			const after = await snapshot();

			expect(await personRef(NOVA.esUserId)).toBe(nova);
			expect(await personRef(ORLA.esUserId)).toBe(orla);
			expect(after.refs).toEqual(
				[...before.refs, "person|es:900200", "person|es:900201"].sort(),
			);
			expect({ ...after, refs: [] }).toEqual({ ...before, refs: [] });

			// And the steps that read those refs now find them.
			const mentored = await mentorLogic.importMentorPairs({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			expect(mentored.imported).toBe(2);
			const requested = await logic.importSpeechRequests({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
			});
			expect(requested.imported).toBe(2);

			// A third apply changes nothing at all.
			const settled = await snapshot();
			await apply(stored.importId, resolutions);
			expect(await snapshot()).toEqual(settled);
		});

		it("writePeopleAndRoles creates no guest for a list-only person, even one the plan calls a guest", async () => {
			// The plan never produces this; the guard is the second lock on the door, so
			// it is driven with a hand-built plan.
			const person = (
				key: string,
				name: string,
				listOnly: boolean,
			): PlanPerson => ({
				key,
				esUserId: null,
				name,
				appearances: {
					roles: listOnly ? 0 : 1,
					attendance: 0,
					awards: 0,
					tableTopics: 0,
					introducedBy: 0,
					memberList: listOnly ? 1 : 0,
					mentorChart: 0,
					speechRequests: 0,
					guestCategories: [],
				},
				listOnly,
				outcome: {
					status: "guest",
					kind: "visitor",
					via: "category",
					guestId: null,
				},
				rejectedChoice: null,
			});
			const plan: ImportPlan = {
				people: [
					person("name:list only", "List Only", true),
					person("name:on a meeting", "On A Meeting", false),
				],
				unresolved: [],
				roleDefinitions: [],
				meetings: [],
				futureMeetings: [],
				introductions: [],
				counts: {} as ImportPlan["counts"],
				contactFills: [],
				contactWarnings: [],
				canApply: true,
			};
			const before = await n(guests);
			const resolved = await logic.writePeopleAndRoles(seed.clubId, plan);

			// The control: a person a meeting names is still made a guest.
			expect(await n(guests)).toBe(before + 1);
			expect(resolved.newGuests).toBe(1);
			expect(resolved.guests.has("name:on a meeting")).toBe(true);
			expect(resolved.guests.has("name:list only")).toBe(false);
			const names = await testDb
				.select({ name: guests.name })
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(names.map((g) => g.name)).toEqual(["On A Meeting"]);
		});
	},
);
