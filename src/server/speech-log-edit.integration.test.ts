/**
 * The speech log's editor (#1159): `editSpeechFromLog` backfills a delivered
 * speech's details, including on a COMPLETED meeting, for the speaker or an
 * admin / officer of the club it was given at.
 *
 * Executes the REAL `createServerFn` handler with only two boundaries faked,
 * as `release-and-speaker-details.integration.test.ts` does: the
 * `createServerFn` adapter and the cookie -> session lookup. The session gate,
 * the roster lookups and the writer all run for real.
 *
 * Every case reads back its own club's rows only (vitest runs files in
 * parallel against one database).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetings,
	members,
	officerTerms,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";
import { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } from "./guards";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

let sessionUserId: string | null = null;
let request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { editSpeechFromLog } = await import("./speeches");
const { updateSpeakerDetails } = await import("./slots");
const { loadSpeechLog } = await import("./my-activity-logic");

describe.skipIf(!hasTestDb)("edit a speech from the speech log (#1159)", () => {
	let seed: SeededClub;
	let speakerRoleId: string;
	let projectId: string;
	let projectIdB: string;
	const tag = randomUUID().slice(0, 8);
	/** Extra users / clubs created per test, for cleanup. */
	let extraUserIds: string[] = [];
	let extraClubIds: string[] = [];

	beforeEach(async () => {
		sessionUserId = null;
		request = { headers: new Headers() };
		extraUserIds = [];
		extraClubIds = [];
		seed = await seedClub();

		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("Failed to seed the speaker role");
		speakerRoleId = def.id;

		await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: "8701", name: "Presentation Mastery" })
			.onConflictDoNothing();
		const [path] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, "8701"));
		if (!path) throw new Error("Failed to seed the path");
		const projects = await testDb
			.insert(pathwaysProjects)
			.values([
				{
					pathId: path.id,
					level: 1,
					name: `Ice Breaker ${tag}-${randomUUID().slice(0, 6)}`,
					isRequired: true,
				},
				{
					pathId: path.id,
					level: 2,
					name: `Other ${tag}-${randomUUID().slice(0, 6)}`,
					isRequired: true,
				},
			])
			.returning({ id: pathwaysProjects.id });
		if (!projects[0] || !projects[1])
			throw new Error("Failed to seed projects");
		projectId = projects[0].id;
		projectIdB = projects[1].id;
	});

	afterEach(async () => {
		sessionUserId = null;
		const clubIds = [seed.clubId, ...extraClubIds];
		// Speeches are Person-owned and not in the club cascade.
		const owners = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(inArray(members.clubId, clubIds));
		const personIds = owners.map((o) => o.personId);
		if (personIds.length > 0) {
			await testDb
				.delete(speeches)
				.where(inArray(speeches.personId, personIds));
		}
		for (const clubId of extraClubIds) await cleanup(clubId, []);
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			...extraUserIds,
		]);
		await testDb
			.delete(pathwaysProjects)
			.where(inArray(pathwaysProjects.id, [projectId, projectIdB]));
	});

	async function setStatus(status: "completed" | "cancelled") {
		await testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, seed.meetingId));
	}

	/** A speaker slot held by `memberId`, with a speech when `title` is given. */
	async function speakerSlot(
		memberId: string,
		opts: { title?: string; clubId?: string } = {},
	) {
		let speechId: string | null = null;
		if (opts.title) {
			const [m] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, memberId));
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: m!.personId, title: opts.title })
				.returning({ id: speeches.id });
			speechId = speech!.id;
		}
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				status: "confirmed",
				assignedMemberId: memberId,
				speechId,
			})
			.returning({ id: roleSlots.id });
		return { slotId: slot!.id, speechId };
	}

	async function emptyMemberSlot(memberId: string) {
		return speakerSlot(memberId);
	}

	async function snapshot(slotId: string) {
		const [slot] = await testDb
			.select({ speechId: roleSlots.speechId })
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		const speech = slot?.speechId
			? (
					await testDb
						.select({
							title: speeches.title,
							projectId: speeches.projectId,
							projectName: speeches.projectName,
						})
						.from(speeches)
						.where(eq(speeches.id, slot.speechId))
				)[0]
			: null;
		return { speechId: slot?.speechId ?? null, speech };
	}

	async function editLog() {
		return testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				targetId: activityLog.targetId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
	}

	async function meetingStatus() {
		const [m] = await testDb
			.select({ status: meetings.status })
			.from(meetings)
			.where(eq(meetings.id, seed.meetingId));
		return m?.status;
	}

	/** Refused, and nothing written: the slot's speech link and fields as they
	 *  were, and no activity row. */
	async function expectRefusedUntouched(
		slotId: string,
		before: Awaited<ReturnType<typeof snapshot>>,
		call: Promise<unknown>,
		message: string | RegExp,
	) {
		await expect(call).rejects.toThrow(message);
		expect(await snapshot(slotId)).toEqual(before);
		expect(await editLog()).toHaveLength(0);
	}

	const withProject = (id = projectId) => ({
		slotId: "",
		speakerDetails: { projectId: id },
	});

	/** A person with a user, a membership and (optionally) an open office. */
	async function addMember(opts: {
		status?: "active" | "inactive";
		officer?: boolean;
	}) {
		const userId = randomUUID();
		extraUserIds.push(userId);
		await testDb.insert(user).values({
			id: userId,
			name: "Extra",
			email: `extra-${userId}@test.example`,
			emailVerified: true,
		});
		const [person] = await testDb
			.insert(people)
			.values({
				name: "Extra",
				email: `extra-${userId}@test.example`,
				userId,
			})
			.returning({ id: people.id });
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: person!.id,
				name: "Extra",
				clubRole: "member",
				status: opts.status ?? "active",
			})
			.returning({ id: members.id });
		if (opts.officer) {
			await testDb.insert(officerTerms).values({
				membershipId: member!.id,
				position: "vp_education",
				termStart: new Date(),
				termEnd: null,
			});
		}
		return { userId, memberId: member!.id };
	}

	describe("accepted", () => {
		it("an admin backfills a project on a completed meeting's speaker slot that has no speech row (AC1)", async () => {
			const { slotId } = await emptyMemberSlot(seed.memberId);
			await setStatus("completed");
			sessionUserId = seed.adminUserId;

			await editSpeechFromLog({
				data: { ...withProject(), slotId },
			});

			const after = await snapshot(slotId);
			expect(after.speech?.projectId).toBe(projectId);
			expect(after.speech?.projectName).toMatch(/^Ice Breaker/);
			expect(await meetingStatus()).toBe("completed");
			const log = await editLog();
			expect(log).toHaveLength(1);
			expect(log[0]).toMatchObject({
				actorMemberId: seed.adminMemberId,
				targetId: seed.meetingId,
				detail: {
					change: "speaker_details",
					slotId,
					speechId: after.speechId,
					before: { title: null, projectId: null },
					after: { projectId },
					proof: "session",
				},
			});
			// The speech belongs to the SPEAKER, not to the admin who typed it.
			const [owner] = await testDb
				.select({ personId: speeches.personId })
				.from(speeches)
				.where(eq(speeches.id, after.speechId as string));
			expect(owner?.personId).toBe(seed.personId);
		});

		it("an admin updates an existing speech in place and the log carries both sides", async () => {
			const { slotId, speechId } = await speakerSlot(seed.memberId, {
				title: "Original Title",
			});
			await setStatus("completed");
			sessionUserId = seed.adminUserId;

			await editSpeechFromLog({
				data: {
					slotId,
					speakerDetails: { speechTitle: "Rewritten", projectId },
				},
			});

			const after = await snapshot(slotId);
			expect(after.speechId).toBe(speechId);
			expect(after.speech).toMatchObject({ title: "Rewritten", projectId });
			const log = await editLog();
			expect(log).toHaveLength(1);
			expect(log[0]?.detail).toMatchObject({
				speechId,
				before: { title: "Original Title", projectId: null },
				after: { title: "Rewritten", projectId },
			});
		});

		it("an officer with an open term and stored role member can do the same (AC2)", async () => {
			const officer = await addMember({ officer: true });
			const { slotId } = await emptyMemberSlot(seed.memberId);
			await setStatus("completed");
			sessionUserId = officer.userId;

			await editSpeechFromLog({ data: { ...withProject(), slotId } });

			expect((await snapshot(slotId)).speech?.projectId).toBe(projectId);
			expect(await editLog()).toHaveLength(1);
			expect((await editLog())[0]?.actorMemberId).toBe(officer.memberId);
		});

		it("a member edits their own speech on a completed meeting (AC3)", async () => {
			const { slotId } = await speakerSlot(seed.memberId, { title: "Mine" });
			await setStatus("completed");
			sessionUserId = seed.memberUserId;

			await editSpeechFromLog({ data: { ...withProject(), slotId } });

			expect((await snapshot(slotId)).speech?.projectId).toBe(projectId);
			expect((await editLog())[0]?.actorMemberId).toBe(seed.memberId);
		});

		it("a former (inactive) member can still edit their own speech (AC4)", async () => {
			const former = await addMember({ status: "inactive" });
			const { slotId } = await emptyMemberSlot(former.memberId);
			await setStatus("completed");
			sessionUserId = former.userId;

			await editSpeechFromLog({ data: { ...withProject(), slotId } });

			expect((await snapshot(slotId)).speech?.projectId).toBe(projectId);
			// Logged as the slot's holder, the speaker arm's actor.
			const log = await editLog();
			expect(log).toHaveLength(1);
			expect(log[0]?.actorMemberId).toBe(former.memberId);
		});

		it("a title-only edit keeps the free-text path, project, level and introduction the form did not send", async () => {
			const { slotId, speechId } = await speakerSlot(seed.memberId, {
				title: "Old title",
			});
			await testDb
				.update(speeches)
				.set({
					introduction: "Introduce me kindly",
					pathwayPath: "Typed Path",
					projectName: "Typed Project",
					projectLevel: "Level 2",
				})
				.where(eq(speeches.id, speechId as string));
			await setStatus("completed");
			sessionUserId = seed.memberUserId;

			// The sheet sends only the title (the picker hides the rest).
			await editSpeechFromLog({
				data: { slotId, speakerDetails: { speechTitle: "New title" } },
			});

			const [row] = await testDb
				.select({
					title: speeches.title,
					introduction: speeches.introduction,
					pathwayPath: speeches.pathwayPath,
					projectName: speeches.projectName,
					projectLevel: speeches.projectLevel,
				})
				.from(speeches)
				.where(eq(speeches.id, speechId as string));
			expect(row).toEqual({
				title: "New title",
				introduction: "Introduce me kindly",
				pathwayPath: "Typed Path",
				projectName: "Typed Project",
				projectLevel: "Level 2",
			});
		});

		it("clearing a catalog project clears the text derived from it, and keeps the introduction", async () => {
			const { slotId } = await emptyMemberSlot(seed.memberId);
			sessionUserId = seed.memberUserId;
			await editSpeechFromLog({
				data: {
					slotId,
					speakerDetails: { speechTitle: "A real title", projectId },
				},
			});
			const linked = (await snapshot(slotId)).speech;
			expect(linked?.projectId).toBe(projectId);
			expect(linked?.projectName).toMatch(/^Ice Breaker/);
			await testDb
				.update(speeches)
				.set({ introduction: "Keep this introduction" })
				.where(eq(speeches.id, (await snapshot(slotId)).speechId as string));

			// What the sheet sends after "Clear project" with the picker's text
			// inputs hidden: the link is null and the free text is absent.
			await editSpeechFromLog({
				data: {
					slotId,
					speakerDetails: { speechTitle: "A real title", projectId: null },
				},
			});

			const [row] = await testDb
				.select({
					projectId: speeches.projectId,
					pathwayPath: speeches.pathwayPath,
					projectName: speeches.projectName,
					projectLevel: speeches.projectLevel,
					introduction: speeches.introduction,
				})
				.from(speeches)
				.where(eq(speeches.id, (await snapshot(slotId)).speechId as string));
			expect(row).toEqual({
				projectId: null,
				pathwayPath: null,
				projectName: null,
				projectLevel: null,
				introduction: "Keep this introduction",
			});
		});

		it("hand-typed text survives a null projectId when the stored speech was never linked", async () => {
			const { slotId, speechId } = await speakerSlot(seed.memberId, {
				title: "Typed",
			});
			await testDb
				.update(speeches)
				.set({ pathwayPath: "Typed Path", projectName: "Typed Project" })
				.where(eq(speeches.id, speechId as string));
			sessionUserId = seed.memberUserId;

			await editSpeechFromLog({
				data: {
					slotId,
					speakerDetails: { speechTitle: "Typed", projectId: null },
				},
			});

			const [row] = await testDb
				.select({
					pathwayPath: speeches.pathwayPath,
					projectName: speeches.projectName,
				})
				.from(speeches)
				.where(eq(speeches.id, speechId as string));
			expect(row).toEqual({
				pathwayPath: "Typed Path",
				projectName: "Typed Project",
			});
		});

		it('a field sent as "" is a deliberate clear, not a keep', async () => {
			const { slotId, speechId } = await speakerSlot(seed.memberId, {
				title: "Old title",
			});
			await testDb
				.update(speeches)
				.set({ pathwayPath: "Typed Path", projectName: "Typed Project" })
				.where(eq(speeches.id, speechId as string));
			sessionUserId = seed.memberUserId;

			await editSpeechFromLog({
				data: {
					slotId,
					speakerDetails: { speechTitle: "Old title", pathwayPath: "" },
				},
			});

			const [row] = await testDb
				.select({
					pathwayPath: speeches.pathwayPath,
					projectName: speeches.projectName,
				})
				.from(speeches)
				.where(eq(speeches.id, speechId as string));
			expect(row).toEqual({ pathwayPath: null, projectName: "Typed Project" });
		});

		it("also works on a scheduled meeting, and a second edit replaces the first project", async () => {
			const { slotId } = await emptyMemberSlot(seed.memberId);
			sessionUserId = seed.memberUserId;

			await editSpeechFromLog({ data: { ...withProject(), slotId } });
			await editSpeechFromLog({
				data: { ...withProject(projectIdB), slotId },
			});

			expect((await snapshot(slotId)).speech?.projectId).toBe(projectIdB);
			expect(await editLog()).toHaveLength(2);
		});

		it("the speech-log rows carry what the sheet prefills (member id, project id, window, slides)", async () => {
			const { slotId } = await emptyMemberSlot(seed.memberId);
			sessionUserId = seed.memberUserId;
			await editSpeechFromLog({
				data: {
					slotId,
					speakerDetails: {
						projectId,
						minMinutes: 4,
						maxMinutes: 6,
						presentationUrl: "https://example.com/slides",
					},
				},
			});

			const { rows } = await loadSpeechLog([seed.memberId], seed.clubId, null);
			expect(rows.find((r) => r.slotId === slotId)).toMatchObject({
				memberId: seed.memberId,
				projectId,
				minMinutes: 4,
				maxMinutes: 6,
				presentationUrl: "https://example.com/slides",
			});
		});
	});

	describe("refused, writing nothing (AC5)", () => {
		it("a plain member editing another member's speech", async () => {
			const { slotId } = await speakerSlot(seed.adminMemberId, {
				title: "Theirs",
			});
			await setStatus("completed");
			const before = await snapshot(slotId);
			sessionUserId = seed.memberUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({ data: { ...withProject(), slotId } }),
				NO_PERMISSION_MESSAGE,
			);
		});

		it("an admin of a different club", async () => {
			const other = await seedClub();
			extraClubIds.push(other.clubId);
			extraUserIds.push(other.adminUserId, other.memberUserId);
			const { slotId } = await speakerSlot(seed.memberId, { title: "Mine" });
			await setStatus("completed");
			const before = await snapshot(slotId);
			sessionUserId = other.adminUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({ data: { ...withProject(), slotId } }),
				NOT_A_MEMBER_MESSAGE,
			);
		});

		it("no session", async () => {
			const { slotId } = await speakerSlot(seed.memberId, { title: "Mine" });
			await setStatus("completed");
			const before = await snapshot(slotId);
			sessionUserId = null;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({ data: { ...withProject(), slotId } }),
				SIGN_IN_REQUIRED_MESSAGE,
			);
		});

		it("a cancelled meeting, even for the speaker", async () => {
			const { slotId } = await speakerSlot(seed.memberId, { title: "Mine" });
			await setStatus("cancelled");
			const before = await snapshot(slotId);
			sessionUserId = seed.memberUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({ data: { ...withProject(), slotId } }),
				/cancel/i,
			);
		});

		it("an archived club, even for the speaker", async () => {
			const { slotId } = await speakerSlot(seed.memberId, { title: "Mine" });
			await setStatus("completed");
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			const before = await snapshot(slotId);
			sessionUserId = seed.memberUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({ data: { ...withProject(), slotId } }),
				CLUB_ARCHIVED_MESSAGE,
			);
		});

		it("a guest-held slot", async () => {
			const [guest] = await testDb
				.insert(guests)
				.values(await withGuestPerson({ clubId: seed.clubId, name: "Gus" }))
				.returning({ id: guests.id });
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: speakerRoleId,
					status: "confirmed",
					assignedGuestId: guest!.id,
				})
				.returning({ id: roleSlots.id });
			await setStatus("completed");
			const before = await snapshot(slot!.id);
			sessionUserId = seed.adminUserId;
			await expectRefusedUntouched(
				slot!.id,
				before,
				editSpeechFromLog({
					data: { ...withProject(), slotId: slot!.id },
				}),
				"Only a member's speech can be edited here.",
			);
		});

		it("a non-speaker slot", async () => {
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: seed.memberId,
					status: "confirmed",
				})
				.where(eq(roleSlots.id, seed.slotId));
			await setStatus("completed");
			const before = await snapshot(seed.slotId);
			sessionUserId = seed.adminUserId;
			await expectRefusedUntouched(
				seed.slotId,
				before,
				editSpeechFromLog({
					data: { ...withProject(), slotId: seed.slotId },
				}),
				"Only speaker roles have speech details.",
			);
		});

		it("an all-blank form on a slot that has a speech: the speech stays linked", async () => {
			const { slotId, speechId } = await speakerSlot(seed.memberId, {
				title: "Keep me",
			});
			await setStatus("completed");
			const before = await snapshot(slotId);
			sessionUserId = seed.memberUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({
					data: { slotId, speakerDetails: { speechTitle: "TBA" } },
				}),
				"Nothing to save. To remove a speech, use the meeting's agenda.",
			);
			expect((await snapshot(slotId)).speechId).toBe(speechId);
		});

		it("the holder of a slot whose speech belongs to someone else (guest re-linked from Alice to Bob)", async () => {
			// Alice's speech stays on the slot when the guest is unlinked
			// (`guest-pipeline-logic` keeps `speechId`); re-linking the slot to Bob
			// leaves a plain-member holder pointing at a speech he does not own.
			// Seeded directly: the speech is owned by the club admin's Person.
			const { slotId } = await speakerSlot(seed.adminMemberId, {
				title: "Alice's speech",
			});
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId })
				.where(eq(roleSlots.id, slotId));
			await setStatus("completed");
			const before = await snapshot(slotId);
			sessionUserId = seed.memberUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				editSpeechFromLog({
					data: { slotId, speakerDetails: { speechTitle: "Bob rewrote it" } },
				}),
				NO_PERMISSION_MESSAGE,
			);

			// An admin still may, through the admin arm.
			sessionUserId = seed.adminUserId;
			await editSpeechFromLog({
				data: { slotId, speakerDetails: { speechTitle: "Admin fixed it" } },
			});
			expect((await snapshot(slotId)).speech?.title).toBe("Admin fixed it");
		});

		it("a blank title plus a cleared project on a catalog-linked speech", async () => {
			const { slotId } = await emptyMemberSlot(seed.memberId);
			sessionUserId = seed.memberUserId;
			await editSpeechFromLog({
				data: { slotId, speakerDetails: { projectId } },
			});
			const before = await snapshot(slotId);
			const logged = (await editLog()).length;
			// Nothing left to save once the project is gone: refused, not unlinked.
			await expect(
				editSpeechFromLog({
					data: { slotId, speakerDetails: { projectId: null } },
				}),
			).rejects.toThrow(
				"Nothing to save. To remove a speech, use the meeting's agenda.",
			);
			expect(await snapshot(slotId)).toEqual(before);
			expect(await editLog()).toHaveLength(logged);
		});

		it("a slot that does not exist", async () => {
			sessionUserId = seed.adminUserId;
			await expect(
				editSpeechFromLog({
					data: { ...withProject(), slotId: randomUUID() },
				}),
			).rejects.toThrow("Role not found.");
		});
	});

	describe("the agenda writer after the split (AC6)", () => {
		it("still refuses a completed meeting", async () => {
			const { slotId } = await speakerSlot(seed.memberId, { title: "Mine" });
			await setStatus("completed");
			const before = await snapshot(slotId);
			sessionUserId = seed.adminUserId;
			await expectRefusedUntouched(
				slotId,
				before,
				updateSpeakerDetails({
					data: { slotId, speakerDetails: { speechTitle: "Rewritten" } },
				}),
				/locked|completed|reopen/i,
			);
		});

		it("a blank save still unlinks the speech, and any signed-in member may edit", async () => {
			const { slotId, speechId } = await speakerSlot(seed.adminMemberId, {
				title: "Theirs",
			});
			sessionUserId = seed.memberUserId;

			await updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "Edited by a peer" } },
			});
			expect((await snapshot(slotId)).speech?.title).toBe("Edited by a peer");

			await updateSpeakerDetails({ data: { slotId, speakerDetails: {} } });
			expect((await snapshot(slotId)).speechId).toBeNull();
			// The speech row persists, unlinked (ADR-0009).
			const [kept] = await testDb
				.select({ id: speeches.id })
				.from(speeches)
				.where(eq(speeches.id, speechId as string));
			expect(kept?.id).toBe(speechId);
		});
	});
});
