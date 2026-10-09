/**
 * `edit_agenda`'s refusal of a frozen meeting, by write class (#1136).
 *
 * `loadEditable` is the ONE read the preview and the apply share, and the apply
 * runs it under the meeting row lock BEFORE `materialiseAgendaForMeeting`
 * stores a never-edited meeting's copy. That writer accepts a cancelled or
 * completed meeting on purpose, so this check is the refusal that holds on the
 * connector's path; these tests pin its sentences, its code, and that a refusal
 * stores nothing.
 *
 * Kept apart from `edit-agenda.integration.test.ts` because it mocks
 * `readAgendaSnapshot` to hand `loadEditable` a status the database cannot hold
 * (the column is an enum), which is the only way to reach the fail-closed
 * branch.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	meetings,
	meetingTemplateBeats,
	meetingTemplates,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** When set, `readAgendaSnapshot` reports THIS status whatever is stored. */
const force = vi.hoisted(() => ({ status: null as string | null }));
vi.mock("#/server/meeting-agenda-edit-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meeting-agenda-edit-logic")>();
	return {
		...actual,
		readAgendaSnapshot: async (
			...args: Parameters<typeof actual.readAgendaSnapshot>
		) => {
			const snap = await actual.readAgendaSnapshot(...args);
			return snap && force.status !== null
				? { ...snap, status: force.status }
				: snap;
		},
	};
});

const { editAgendaTool } = await import("#/server/mcp/tools/edit-agenda");
const { McpError } = await import("#/server/mcp/errors");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { AGENDA_CANCELLED_MESSAGE, loadAgendaDraft } = await import(
	"#/server/meeting-agenda-edit-logic"
);

type Frozen = "cancelled" | "completed";
const FROZEN: readonly (readonly [Frozen, string])[] = [
	["cancelled", AGENDA_CANCELLED_MESSAGE],
	["completed", MEETING_LOCKED_MESSAGE],
];

describe.skipIf(!hasTestDb)(
	"edit_agenda refuses a frozen meeting (#1136)",
	() => {
		let seed: SeededClub;
		let token: string;

		const opening = {
			op: "add",
			label: "Introductions",
			minutes: 15,
			at: "start",
		} as const;

		const edit = (args: Record<string, unknown>) =>
			editAgendaTool.handler(args, { rawToken: token });

		async function freeze(status: Frozen) {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, seed.meetingId));
		}

		/** The meeting's stored agenda rows, in order. */
		async function stored() {
			const [m] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, seed.meetingId));
			if (!m?.templateId) return [];
			return testDb
				.select({
					id: meetingTemplateBeats.id,
					label: meetingTemplateBeats.label,
					minutes: meetingTemplateBeats.minutes,
				})
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, m.templateId))
				.orderBy(asc(meetingTemplateBeats.sortOrder));
		}

		/** What a refusal must not change: the pointer, the club's templates, and
		 *  their rows. A never-edited meeting that gains a copy shows up here. */
		async function footprint() {
			const [m] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, seed.meetingId));
			const templates = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, seed.clubId))
				.orderBy(meetingTemplates.id);
			return {
				templateId: m?.templateId ?? null,
				templates: templates.map((t) => t.id),
				rows: await stored(),
			};
		}

		/** A preview under the meeting's real (scheduled) status, for its hash. */
		async function previewHash(): Promise<string> {
			const preview = (await edit({
				meetingId: seed.meetingId,
				operations: [opening],
			})) as { planHash: string };
			return preview.planHash;
		}

		beforeEach(async () => {
			force.status = null;
			seed = await seedClub();
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
			token = raw;
		});

		afterEach(async () => {
			force.status = null;
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("refuses a cancelled never-edited meeting in the preview, with the agenda's own sentence", async () => {
			const before = await footprint();
			expect(before.templateId).toBeNull();
			await freeze("cancelled");
			await expect(
				edit({ meetingId: seed.meetingId, operations: [opening] }),
			).rejects.toMatchObject({
				code: "LOCKED",
				message: AGENDA_CANCELLED_MESSAGE,
			});
			expect(await footprint()).toEqual(before);
		});

		it("refuses a completed never-edited meeting in the apply BEFORE storing its copy", async () => {
			const planHash = await previewHash();
			const before = await footprint();
			expect(before.templateId).toBeNull();
			await freeze("completed");
			await expect(
				edit({ meetingId: seed.meetingId, operations: [opening], planHash }),
			).rejects.toMatchObject({
				code: "LOCKED",
				message: MEETING_LOCKED_MESSAGE,
			});
			// `materialiseAgendaForMeeting` accepts a frozen meeting, so only this
			// refusal stands between a completed meeting and a stored copy.
			expect(await footprint()).toEqual(before);
		});

		for (const [status, message] of FROZEN) {
			it(`refuses a ${status} meeting whose agenda was already edited, in preview and apply`, async () => {
				await loadAgendaDraft(seed.meetingId);
				const planHash = await previewHash();
				const before = await footprint();
				expect(before.templateId).not.toBeNull();
				expect(before.rows.length).toBeGreaterThan(0);
				await freeze(status);

				await expect(
					edit({ meetingId: seed.meetingId, operations: [opening] }),
				).rejects.toMatchObject({ code: "LOCKED", message });
				await expect(
					edit({ meetingId: seed.meetingId, operations: [opening], planHash }),
				).rejects.toMatchObject({ code: "LOCKED", message });
				expect(await footprint()).toEqual(before);
			});
		}

		describe("a status the write policy has never heard of", () => {
			// The enum cannot hold one, so `readAgendaSnapshot` is made to report it.
			// It must read as a failure to the caller, not as a lock: a `LOCKED`
			// would tell them to wait for a meeting that no state change will free.
			async function rejection(args: Record<string, unknown>) {
				return edit(args).then(
					() => {
						throw new Error("expected the call to be refused");
					},
					(err: unknown) => err,
				);
			}

			it("is not LOCKED in the preview, says so, and stores nothing", async () => {
				const before = await footprint();
				force.status = "paused";
				const err = await rejection({
					meetingId: seed.meetingId,
					operations: [opening],
				});
				expect(err).toBeInstanceOf(Error);
				expect(err).not.toBeInstanceOf(McpError);
				expect((err as Error).message).toBe("Unknown meeting status: paused");
				expect(await footprint()).toEqual(before);
			});

			it("is not LOCKED in the apply, says so, and stores nothing", async () => {
				const planHash = await previewHash();
				const before = await footprint();
				expect(before.templateId).toBeNull();
				force.status = "paused";
				const err = await rejection({
					meetingId: seed.meetingId,
					operations: [opening],
					planHash,
				});
				expect(err).toBeInstanceOf(Error);
				expect(err).not.toBeInstanceOf(McpError);
				expect((err as Error).message).toBe("Unknown meeting status: paused");
				expect(await footprint()).toEqual(before);
			});
		});
	},
);
