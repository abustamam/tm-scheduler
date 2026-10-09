/**
 * DB-backed tests for the `evaluates` field of `loadPublicPersonalMeetingView`
 * (#1163): who a paired Evaluator evaluates, and that speech's project.
 *
 * The loader also serves the session-less `?as=` view, and the speaker is a
 * third person to whoever opens the link, so the leak case seeds an email and a
 * phone on the speaker and asserts neither reaches the payload.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	members,
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
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting-logic"
);

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

const SPEAKER_EMAIL = "priyanka.speaker@test.example";
const SPEAKER_PHONE = "+15557654321";

/** The seeded member holds an Evaluator slot, paired to a Speaker slot. */
async function seedPair(opts: {
	holder: "member" | "guest" | "none";
	projectName?: string | null;
	paired?: boolean;
}) {
	const s = await seedClub();
	seeded = s;
	const [speakerDef] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });
	const [evalDef] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name: "Evaluator",
			key: "evaluator",
			category: "evaluator",
		})
		.returning({ id: roleDefinitions.id });

	const [speech] = await testDb
		.insert(speeches)
		.values({
			personId: s.personId,
			title: "My first speech",
			projectName: opts.projectName ?? null,
		})
		.returning({ id: speeches.id });

	let assignedMemberId: string | undefined;
	let assignedGuestId: string | undefined;
	if (opts.holder === "member") {
		const personId = await seedPerson({
			name: "Priyanka Rao",
			email: SPEAKER_EMAIL,
			phone: SPEAKER_PHONE,
		});
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: s.clubId,
				personId,
				name: "Priyanka Rao",
				preferredName: "Priya",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		assignedMemberId = m?.id;
	} else if (opts.holder === "guest") {
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson({
					clubId: s.clubId,
					name: "Gus Guest",
					preferredName: "Gus G",
					email: SPEAKER_EMAIL,
					phone: SPEAKER_PHONE,
				}),
			)
			.returning({ id: guests.id });
		assignedGuestId = g?.id;
	}

	const [speakerSlot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: s.meetingId,
			roleDefinitionId: speakerDef?.id as string,
			assignedMemberId,
			assignedGuestId,
			status: opts.holder === "none" ? "open" : "claimed",
			slotIndex: 1,
			speechId: speech?.id,
		})
		.returning({ id: roleSlots.id });
	await testDb.insert(roleSlots).values({
		meetingId: s.meetingId,
		roleDefinitionId: evalDef?.id as string,
		assignedMemberId: s.memberId,
		status: "claimed",
		slotIndex: 1,
		evaluatesSlotId: opts.paired === false ? null : speakerSlot?.id,
	});
	// The seeded Timer slot stays open and is not the member's.
	await testDb.delete(roleSlots).where(eq(roleSlots.id, s.slotId));
	return s;
}

const evaluatorRole = async (s: SeededClub) => {
	const view = await loadPublicPersonalMeetingView({
		clubId: s.clubId,
		meetingKey: s.meetingId,
		memberId: s.memberId,
	});
	return { view, role: view?.roles.find((r) => r.roleName === "Evaluator") };
};

describe.skipIf(!hasTestDb)(
	"personal meeting loader: evaluates (#1163)",
	() => {
		it("names a member speaker, their preferred name and their project", async () => {
			const s = await seedPair({
				holder: "member",
				projectName: "Ice Breaker",
			});
			const { role } = await evaluatorRole(s);
			expect(role?.evaluates).toEqual({
				speakerName: "Priyanka Rao",
				speakerPreferredName: "Priya",
				projectName: "Ice Breaker",
			});
		});

		it("names a guest speaker, by the club's name for them", async () => {
			const s = await seedPair({ holder: "guest", projectName: "Ice Breaker" });
			const { role } = await evaluatorRole(s);
			expect(role?.evaluates).toEqual({
				speakerName: "Gus Guest",
				speakerPreferredName: "Gus G",
				projectName: "Ice Breaker",
			});
		});

		it("is present with a null speaker when the paired slot has no holder", async () => {
			const s = await seedPair({ holder: "none", projectName: "Ice Breaker" });
			const { role } = await evaluatorRole(s);
			expect(role?.evaluates?.speakerName).toBeNull();
		});

		it("is null for an unpaired evaluator", async () => {
			const s = await seedPair({ holder: "member", paired: false });
			const { role } = await evaluatorRole(s);
			expect(role).toBeDefined();
			expect(role?.evaluates).toBeNull();
		});

		it("never carries the speaker's email or phone", async () => {
			for (const holder of ["member", "guest"] as const) {
				const s = await seedPair({ holder, projectName: "Ice Breaker" });
				const { view, role } = await evaluatorRole(s);
				// Not vacuous: the pairing resolved, so a leak had somewhere to land.
				expect(role?.evaluates?.speakerName).not.toBeNull();
				const serialized = JSON.stringify(view);
				expect(serialized).not.toContain(SPEAKER_EMAIL);
				expect(serialized).not.toContain("7654321");
				expect(Object.keys(role?.evaluates ?? {}).sort()).toEqual([
					"projectName",
					"speakerName",
					"speakerPreferredName",
				]);
				await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
				seeded = null;
			}
		});
	},
);
