/**
 * DB-backed tests for the `evaluates` links on the REAL `getMeeting` payload
 * (#1163), which is what the agenda and the attendance rail draft from.
 *
 * Two things ride on it. The speaker's preferred name is a manager-only contact
 * field, attached AFTER `loadMeetingSlots` resolves the pairing, so `getMeeting`
 * resolves the links again over the rows that carry it. And the project is the
 * personal page's: the catalog name first, then the free text, so a draft and
 * the page name the same form.
 *
 * The session is faked at the library boundary (as `attendance-decline`'s suite
 * does), so `canManageClub` and the rest of the guards run against real rows.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	members,
	pathwaysPaths,
	pathwaysProjects,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { evaluatorFormBrief } from "#/lib/evaluator-form";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// `createServerFn` cannot run its handler under vitest (no compile step), so the
// adapter hands back the handler itself: the REAL `loadMeetingDetail` runs.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
const request = { headers: new Headers() };
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

const { getMeeting } = await import("#/server/meetings");
const { loadPublicPersonalMeetingView } = await import(
	"#/server/personal-meeting-logic"
);

let seeded: SeededClub | null = null;
let pathId: string | null = null;

afterEach(async () => {
	sessionUserId = null;
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
	// The catalog is global, so the club's cascade does not reach it.
	if (pathId) {
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, pathId));
		pathId = null;
	}
});

/** The seeded member evaluates a speaker who goes by "Priya". */
async function seedPair(opts: {
	catalogProject?: string | null;
	freeTextProject?: string | null;
}) {
	const s = await seedClub();
	seeded = s;
	let projectId: string | undefined;
	if (opts.catalogProject) {
		const [path] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: randomUUID(), name: "Test Path" })
			.returning({ id: pathwaysPaths.id });
		pathId = path?.id ?? null;
		const [project] = await testDb
			.insert(pathwaysProjects)
			.values({
				pathId: pathId as string,
				level: 1,
				name: opts.catalogProject,
			})
			.returning({ id: pathwaysProjects.id });
		projectId = project?.id;
	}
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
	const speakerPersonId = await seedPerson({ name: "Priyanka Rao" });
	const [speaker] = await testDb
		.insert(members)
		.values({
			clubId: s.clubId,
			personId: speakerPersonId,
			name: "Priyanka Rao",
			preferredName: "Priya",
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	const [speech] = await testDb
		.insert(speeches)
		.values({
			personId: speakerPersonId,
			title: "My first speech",
			projectId,
			projectName: opts.freeTextProject ?? null,
		})
		.returning({ id: speeches.id });
	const [speakerSlot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: s.meetingId,
			roleDefinitionId: speakerDef?.id as string,
			assignedMemberId: speaker?.id,
			status: "claimed",
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
		evaluatesSlotId: speakerSlot?.id,
	});
	return s;
}

const evaluatorSlot = async (s: SeededClub) => {
	const detail = await getMeeting({ data: s.meetingId });
	return detail.slots.find((slot) => slot.roleName === "Evaluator");
};

describe.skipIf(!hasTestDb)("getMeeting: evaluates (#1163)", () => {
	it("a manager's payload carries the speaker's preferred name", async () => {
		const s = await seedPair({ freeTextProject: "Ice Breaker" });
		sessionUserId = s.adminUserId;
		const slot = await evaluatorSlot(s);
		expect(slot?.evaluates?.speakerName).toBe("Priyanka Rao");
		expect(slot?.evaluates?.speakerPreferredName).toBe("Priya");
		expect(evaluatorFormBrief(slot?.evaluates ?? null)?.speaker).toBe("Priya");
	});

	it("keeps the manager-only gate: a visitor gets the name but no preferred name", async () => {
		const s = await seedPair({ freeTextProject: "Ice Breaker" });
		sessionUserId = null;
		const slot = await evaluatorSlot(s);
		expect(slot?.evaluates?.speakerName).toBe("Priyanka Rao");
		expect(slot?.evaluates?.speakerPreferredName).toBeNull();
	});

	it("names the project the personal page names: the catalog name beats the free text", async () => {
		const s = await seedPair({
			catalogProject: "Ice Breaker",
			freeTextProject: "Evaluation and Feedback",
		});
		sessionUserId = s.adminUserId;
		const slot = await evaluatorSlot(s);
		expect(slot?.evaluates?.projectName).toBe("Ice Breaker");

		const page = await loadPublicPersonalMeetingView({
			clubId: s.clubId,
			meetingKey: s.meetingId,
			memberId: s.memberId,
		});
		const pageRole = page?.roles.find((r) => r.roleName === "Evaluator");
		const draftForm = evaluatorFormBrief(slot?.evaluates ?? null);
		const pageForm = evaluatorFormBrief(pageRole?.evaluates ?? null);
		expect(draftForm?.isGenericFallback).toBe(false);
		expect(draftForm?.resources.map((r) => r.key)).toEqual(
			pageForm?.resources.map((r) => r.key),
		);
		expect(draftForm?.resources.map((r) => r.key)).toEqual(["ice-breaker"]);
	});

	it("falls back to the free text when the speech has no catalog project, and to null with neither", async () => {
		const s = await seedPair({ freeTextProject: "Ice Breaker" });
		sessionUserId = s.adminUserId;
		expect((await evaluatorSlot(s))?.evaluates?.projectName).toBe(
			"Ice Breaker",
		);
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
		seeded = null;

		const t = await seedPair({});
		sessionUserId = t.adminUserId;
		expect((await evaluatorSlot(t))?.evaluates?.projectName).toBeNull();
	});
});
