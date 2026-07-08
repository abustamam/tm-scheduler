/**
 * One-time backfill: import extracted meeting agendas (`ref/agendas/*.json`)
 * into `meetings` + `role_slots` + `speeches` (agenda role-history backfill).
 *
 * Usage:
 *   bun run import-agendas                # dry run — prints a report, no writes
 *   bun run import-agendas -- --commit    # applies writes idempotently
 *
 * Requires IMPORT_CLUB_ID (the target club's id) in the environment.
 * Bun auto-loads .env.local for DATABASE_URL.
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { meetings, members, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import {
	type AgendaRecord,
	type MeetingPlan,
	missingRoleDefinitions,
	normalizeName,
	type PlannedSlot,
	planMeetingImport,
	type RoleDef,
	type RosterMember,
	type UnmatchedEntry,
} from "./import-agendas-logic";

export type WriterContext = {
	clubId: string;
	roster: RosterMember[];
	roleDefs: RoleDef[];
};

const CLUB_START_HOUR = 18; // 6 PM
const CLUB_START_MIN = 45; // :45

function scheduledAtFor(dateISO: string): Date {
	const [y, mo, d] = dateISO.split("-").map(Number);
	return new Date(y, mo - 1, d, CLUB_START_HOUR, CLUB_START_MIN, 0, 0);
}

/**
 * Ensure the "Vote Counter" role definition exists for the club (creating it
 * if missing) and return the refreshed role-def list.
 *
 * MUST be called — with the result assigned back onto `ctx.roleDefs` — before
 * `planMeetingImport` runs for any record. `planMeetingImport` can only map a
 * role row to a slot when a matching role definition is already present in
 * `roleDefs`; if Vote Counter isn't ensured first, a Vote Counter agenda row
 * on the very first imported meeting would land in `unmatched` (reason
 * "missing-definition") instead of becoming a slot, even though the
 * definition gets created moments later.
 */
export async function ensureRoleDefs(ctx: WriterContext): Promise<RoleDef[]> {
	const toCreate = missingRoleDefinitions(ctx.roleDefs);
	if (toCreate.length === 0) return ctx.roleDefs;
	for (const def of toCreate) {
		await db.insert(roleDefinitions).values({ clubId: ctx.clubId, ...def });
	}
	return db
		.select({ id: roleDefinitions.id, name: roleDefinitions.name })
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, ctx.clubId));
}

/**
 * Apply one meeting's plan to the DB, idempotently:
 * - Meeting: upsert on (clubId, scheduledAt).
 * - Slots: delete this meeting's role_slots, then re-insert the planned slots.
 * - Speeches: reuse an existing person-owned speech matched by (personId,
 *   normalized title); otherwise insert. Re-runs never duplicate speeches.
 * - Evaluator pairing: after inserting slots, point each evaluator slot's
 *   evaluates_slot_id at this meeting's Speaker slot at the target slotIndex.
 *
 * Callers must call `ensureRoleDefs` (and use its result as `ctx.roleDefs`)
 * before building `plan` via `planMeetingImport` — see that function's doc.
 */
export async function applyMeetingPlan(
	plan: MeetingPlan,
	ctx: WriterContext,
): Promise<void> {
	const scheduledAt = scheduledAtFor(plan.meeting.date);

	// Upsert meeting on (clubId, scheduledAt).
	const existing = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(eq(meetings.clubId, ctx.clubId), eq(meetings.scheduledAt, scheduledAt)),
		);
	let meetingId: string;
	if (existing[0]) {
		meetingId = existing[0].id;
		await db
			.update(meetings)
			.set({
				theme: plan.meeting.theme,
				wordOfTheDay: plan.meeting.wordOfTheDay,
				lengthMinutes: plan.meeting.lengthMinutes,
				status: plan.meeting.status,
			})
			.where(eq(meetings.id, meetingId));
	} else {
		const inserted = await db
			.insert(meetings)
			.values({
				clubId: ctx.clubId,
				scheduledAt,
				theme: plan.meeting.theme,
				wordOfTheDay: plan.meeting.wordOfTheDay,
				lengthMinutes: plan.meeting.lengthMinutes,
				status: plan.meeting.status,
			})
			.returning({ id: meetings.id });
		const row = inserted[0];
		if (!row) throw new Error("Failed to insert meeting");
		meetingId = row.id;
	}

	// Re-derive slots: delete then re-insert. Deleting only nulls speech_id
	// pointers (speech FK is onDelete: set null) — durable speeches survive.
	await db.delete(roleSlots).where(eq(roleSlots.meetingId, meetingId));

	const defById = new Map(ctx.roleDefs.map((d) => [d.id, d]));
	const speakerSlotIdByIndex = new Map<number, string>();
	const insertedIdBySlot = new Map<PlannedSlot, string>();

	for (const s of plan.slots) {
		let speechId: string | null = null;
		if (s.speech) {
			const norm = normalizeName(s.speech.title);
			const personSpeeches = await db
				.select({ id: speeches.id, title: speeches.title })
				.from(speeches)
				.where(eq(speeches.personId, s.speech.personId));
			const found = personSpeeches.find((row) => normalizeName(row.title) === norm);
			if (found) {
				speechId = found.id;
			} else {
				const ins = await db
					.insert(speeches)
					.values({
						personId: s.speech.personId,
						title: s.speech.title,
						projectLevel: s.speech.projectLevel,
						projectName: s.speech.projectName,
					})
					.returning({ id: speeches.id });
				const row = ins[0];
				if (!row) throw new Error("Failed to insert speech");
				speechId = row.id;
			}
		}

		const ins = await db
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: s.roleDefinitionId,
				slotIndex: s.slotIndex,
				assignedMemberId: s.assignedMemberId,
				status: s.status,
				speechId,
				claimedAt: scheduledAt,
			})
			.returning({ id: roleSlots.id });
		const row = ins[0];
		if (!row) throw new Error("Failed to insert role slot");
		insertedIdBySlot.set(s, row.id);

		const def = defById.get(s.roleDefinitionId);
		if (def?.name === "Speaker") speakerSlotIdByIndex.set(s.slotIndex, row.id);
	}

	// Evaluator pairing pass — needs every Speaker slot already inserted.
	for (const s of plan.slots) {
		if (!s.evaluatesTarget || s.evaluatesTarget.roleName !== "Speaker") continue;
		const slotId = insertedIdBySlot.get(s);
		const speakerId = speakerSlotIdByIndex.get(s.evaluatesTarget.slotIndex);
		if (slotId && speakerId) {
			await db
				.update(roleSlots)
				.set({ evaluatesSlotId: speakerId })
				.where(eq(roleSlots.id, slotId));
		}
	}
}

// ---- CLI entrypoint (only runs when invoked directly, not under test import) ----

async function loadContext(clubId: string): Promise<WriterContext> {
	const roster = await db
		.select({ memberId: members.id, personId: members.personId, name: members.name })
		.from(members)
		.where(eq(members.clubId, clubId));
	const roleDefs = await db
		.select({ id: roleDefinitions.id, name: roleDefinitions.name })
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
	return { clubId, roster, roleDefs };
}

function loadRecords(dir: string): AgendaRecord[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && f !== "aliases.json" && f !== "index.json")
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as AgendaRecord);
}

/** One human-readable line per unmatched row, distinguishing the failure mode. */
function formatUnmatched(record: AgendaRecord, u: UnmatchedEntry): string {
	const head = `#${record.meetingNumber ?? "?"} ${record.date} · ${u.label} · "${u.name}"`;
	if (u.kind === "name") {
		const suggestion = u.suggestions.length
			? ` (did you mean: ${u.suggestions.join(", ")}?)`
			: "";
		return `${head} [name]${suggestion}`;
	}
	return `${head} [role: ${u.reason}]`;
}

async function main() {
	const commit = process.argv.includes("--commit");
	const clubId = process.env.IMPORT_CLUB_ID;
	if (!clubId) throw new Error("Set IMPORT_CLUB_ID to the target club id.");

	const dir = "ref/agendas";
	const aliases = JSON.parse(
		readFileSync(join(dir, "aliases.json"), "utf8"),
	) as Record<string, string>;
	const records = loadRecords(dir);

	const ctx = await loadContext(clubId);
	// Ensure Vote Counter exists once, up front — before any record is planned —
	// so it's available to `planMeetingImport` for every record in this run.
	// Skipped in dry-run mode: dry runs never write to the DB, so a Vote
	// Counter row is reported (as `missing-definition`) rather than created.
	if (commit) ctx.roleDefs = await ensureRoleDefs(ctx);

	let meetingsN = 0;
	let slotsN = 0;
	let speechesN = 0;
	const unmatched: string[] = [];

	for (const record of records) {
		const plan = planMeetingImport(record, ctx.roster, ctx.roleDefs, aliases);
		meetingsN += 1;
		slotsN += plan.slots.length;
		speechesN += plan.slots.filter((s) => s.speech).length;
		for (const u of plan.unmatched) unmatched.push(formatUnmatched(record, u));
		if (commit) await applyMeetingPlan(plan, ctx);
	}

	console.log(`Meetings: ${meetingsN}  Slots: ${slotsN}  Speeches: ${speechesN}`);
	console.log(`Unmatched/skipped rows: ${unmatched.length}`);
	for (const line of unmatched) console.log(`  - ${line}`);
	console.log(commit ? "\nCOMMITTED to the database." : "\nDRY RUN — pass --commit to write.");
	process.exit(0);
}

// Run main() only as a CLI, never when imported by tests.
if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
