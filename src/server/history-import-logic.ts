/**
 * Easy-Speak import: store a bundle, preview it, apply it, and keep the
 * reconciliation report (#1051, part of #1054).
 *
 * The planning rules are pure and live in `#/lib/easy-speak-import-plan`; this
 * module reads what the club holds, hands it to the planner, and writes what the
 * plan says. It has NO session of its own: `history-import.ts` runs the
 * superadmin gate before it calls anything here, and the MCP tool authorises a
 * club admin before it calls {@link loadImportReport}.
 *
 * ## Apply rules
 *
 * - **Insert what is missing, never overwrite.** A row an `import_refs` entry
 *   already names is left exactly as it is, so a re-run changes nothing a human
 *   edited since, and a guest converted to a member after the first run is not
 *   pointed back at the guest row. The one "update" is filling a blank: an
 *   existing meeting's empty theme, Word of the Day, venue or join link takes the
 *   bundle's value. A meeting already on the calendar at the same instant is
 *   ADOPTED (given a ref) rather than duplicated, and a role slot someone already
 *   holds there stays theirs.
 * - **One transaction per meeting, in date order.** A meeting that throws is
 *   rolled back whole, skipped and reported; its neighbours still land. People
 *   and role definitions are written first, in their own transaction, because
 *   every meeting needs them and each is idempotent by ref or by name.
 * - **A guest's speech belongs to that guest.** A speech is owned by the Person
 *   (member) or by the guest who holds the slot it sits on, never by one and
 *   attached to the other's slot. Converting or linking a guest later leaves the
 *   speech on the guest row, exactly as it leaves the guest's attendance and
 *   awards: guest history stays guest history (see the PR for #1051).
 * - **The introducer is validated where it is written.** `guests.introduced_by_member_id`
 *   has no database check that the member belongs to the guest's club, so
 *   {@link validatedIntroducerId} asks, and throws, before any guest row names one.
 *
 * ## Where the report lives
 *
 * `club_imports` has no report column and this issue carries no migration, so the
 * apply stores `{ resolutions, report }` under the reserved top-level key
 * `importState` of the row's `bundle` jsonb. The bundle schema strips unknown
 * keys, so a stored bundle still parses as the bundle it was, and the hash is of
 * the uploaded text, never of the row. A dedicated column would be cleaner.
 *
 * `club_imports.bundle` keeps every guest's name until the club itself is deleted
 * (the row cascades from the club). That is the stated retention; nothing here
 * prunes it.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	clubImports,
	clubs,
	guests,
	importRefs,
	meetingAttendance,
	meetingAwards,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	speechRequests,
	tableTopicsSpeakers,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import {
	type EasySpeakBundleV1,
	easySpeakBundleV1Schema,
} from "#/lib/easy-speak-bundle";
import {
	buildImportPlan,
	buildReconciliation,
	DELETED_SINCE_IMPORT,
	type FoundSourceIds,
	type ImportPlan,
	type ImportReport,
	isJsonbSafeText,
	leftAloneReason,
	MEETING_LEFT_ALONE,
	needsDecision,
	type Omission,
	type PersonResolution,
	type PlanContext,
	type PlanCounts,
	type PlanMeeting,
	type PlanPerson,
	type PlanRosterMember,
	personKeyOf,
	resolutionsSchema,
	scrubJsonbText,
} from "#/lib/easy-speak-import-plan";
import {
	bundleTooBigMessage,
	MAX_BUNDLE_BYTES,
} from "#/lib/import-bundle-limit";
import { type ImportRefKind, importRefKindSchema } from "#/lib/import-refs";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import {
	clipImportedText,
	normalizePreferredDates,
} from "#/lib/speech-requests";
import { logActivity } from "./activity";
import { importPlanAnswers } from "./attendance-plan-logic";
import { lockClubForWrite } from "./club-write-lock";
import { createGuestRecord } from "./guests-logic";

export type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export const SOURCE = "easy_speak" as const;

/**
 * The archive gate, re-read INSIDE a write transaction, right after the club
 * write lock: `applyEasySpeakImport` checks it once up front, but an apply
 * writes for minutes, one transaction per meeting, and the club can be archived
 * between any two of them. An archived club takes no more writes (ADR-0016).
 */
export async function assertClubNotArchivedTx(
	tx: Tx,
	clubId: string,
): Promise<void> {
	const [club] = await tx
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1)
		// FOR SHARE: a plain read does not block `archiveClub`'s UPDATE, so the
		// club could be archived after this check and before the transaction
		// commits (#1206). The share lock makes the archive wait for us.
		.for("share");
	if (!club) throw new Error("Club not found.");
	if (isClubArchived(club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
}

export const IMPORT_NOT_FOUND_MESSAGE =
	"That import was not found for this club.";
export const UNRESOLVED_PEOPLE_MESSAGE = (n: number) =>
	`${n} ${n === 1 ? "person still needs" : "people still need"} a decision before this can be applied.`;
export const PLAN_CHANGED_MESSAGE =
	"The club or the bundle changed since this preview. Preview again before applying.";
export const IMPORT_RUNNING_MESSAGE =
	"An import is already running for this club. Wait for it to finish, then preview again.";
export const INTRODUCER_NOT_IN_CLUB_MESSAGE =
	"The member who introduced this guest is not in this club.";

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** Every string and key in a parsed JSON value can be kept in a jsonb column. */
function allTextIsJsonbSafe(value: unknown): boolean {
	if (typeof value === "string") return isJsonbSafeText(value);
	if (Array.isArray(value)) return value.every(allTextIsJsonbSafe);
	if (value && typeof value === "object") {
		return Object.entries(value).every(
			([k, v]) => isJsonbSafeText(k) && allTextIsJsonbSafe(v),
		);
	}
	return true;
}

/** What an upload refusal says, for a toast. */
export class BundleRefusal extends Error {}

export interface StoredImport {
	importId: string;
	/** True when the same bundle (by hash) was already stored for this club. */
	reused: boolean;
	appliedAt: Date | null;
}

/**
 * Validate an uploaded bundle with `easy-speak-bundle.ts` and store it in
 * `club_imports`. The same hash for the same club is the same row.
 *
 * The raw TEXT is what is hashed, and the parsed JSON (not zod's output, which
 * drops keys the schema does not know) is what is stored, so the row keeps the
 * bundle exactly as it was exported.
 */
export async function storeEasySpeakBundle(input: {
	clubId: string;
	uploadedByUserId: string;
	text: string;
}): Promise<StoredImport> {
	const bytes = Buffer.byteLength(input.text, "utf8");
	if (bytes > MAX_BUNDLE_BYTES) {
		throw new BundleRefusal(bundleTooBigMessage(bytes));
	}
	// A `\u0000` escape parses fine and then aborts the jsonb insert: refuse it
	// here with a sentence instead of a database error.
	if (/\\u0000/iu.test(input.text)) {
		throw new BundleRefusal("That bundle contains NUL characters.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.text);
	} catch {
		throw new BundleRefusal("That file is not valid JSON.");
	}
	// An unpaired surrogate escape parses fine, then aborts the jsonb insert.
	if (!allTextIsJsonbSafe(parsed)) {
		throw new BundleRefusal(
			"That bundle contains text that cannot be stored (an unpaired surrogate).",
		);
	}
	const check = easySpeakBundleV1Schema.safeParse(parsed);
	if (!check.success) {
		const issue = check.error.issues[0];
		const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
		throw new BundleRefusal(
			`That is not an Easy-Speak bundle: ${issue?.message ?? "invalid"}${where}.`,
		);
	}
	const bundleSha256 = createHash("sha256").update(input.text).digest("hex");

	const [club] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, input.clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");
	if (isClubArchived(club)) throw new Error(CLUB_ARCHIVED_MESSAGE);

	const find = () =>
		db
			.select({ id: clubImports.id, appliedAt: clubImports.appliedAt })
			.from(clubImports)
			.where(
				and(
					eq(clubImports.clubId, input.clubId),
					eq(clubImports.bundleSha256, bundleSha256),
				),
			)
			.limit(1);
	const [existing] = await find();
	if (existing) {
		return {
			importId: existing.id,
			reused: true,
			appliedAt: existing.appliedAt,
		};
	}
	const [inserted] = await db
		.insert(clubImports)
		.values({
			clubId: input.clubId,
			source: SOURCE,
			bundle: parsed,
			bundleSha256,
			uploadedByUserId: input.uploadedByUserId,
		})
		.onConflictDoNothing()
		.returning({ id: clubImports.id });
	if (inserted) {
		return { importId: inserted.id, reused: false, appliedAt: null };
	}
	// Lost a race with the same upload: it is the row now.
	const [raced] = await find();
	if (!raced) throw new Error("Could not store the bundle.");
	return { importId: raced.id, reused: true, appliedAt: raced.appliedAt };
}

// ---------------------------------------------------------------------------
// Reading a stored import
// ---------------------------------------------------------------------------

interface ImportState {
	resolutions: Record<string, PersonResolution>;
	report: ImportReport | null;
}

export async function loadStoredBundle(
	clubId: string,
	importId: string,
): Promise<{
	bundle: EasySpeakBundleV1;
	bundleSha256: string;
	appliedAt: Date | null;
	state: ImportState;
}> {
	const [row] = await db
		.select({
			bundle: clubImports.bundle,
			bundleSha256: clubImports.bundleSha256,
			appliedAt: clubImports.appliedAt,
		})
		.from(clubImports)
		.where(and(eq(clubImports.id, importId), eq(clubImports.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error(IMPORT_NOT_FOUND_MESSAGE);
	const bundle = easySpeakBundleV1Schema.parse(row.bundle);
	const rawState = (row.bundle as { importState?: unknown }).importState;
	return {
		bundle,
		bundleSha256: row.bundleSha256,
		appliedAt: row.appliedAt,
		state: parseImportState(rawState),
	};
}

function parseImportState(raw: unknown): ImportState {
	const state = (raw ?? {}) as { resolutions?: unknown; report?: unknown };
	const resolutions = resolutionsSchema.safeParse(state.resolutions ?? {});
	return {
		resolutions: resolutions.success ? resolutions.data : {},
		report: (state.report as ImportReport | undefined) ?? null,
	};
}

export interface ImportListRow {
	importId: string;
	createdAt: Date;
	appliedAt: Date | null;
	clubName: string | null;
	meetings: number;
	reconciled: boolean | null;
}

/** A club's stored imports, newest first, without parsing any bundle. */
export async function listClubImports(
	clubId: string,
): Promise<ImportListRow[]> {
	const rows = await db
		.select({
			importId: clubImports.id,
			createdAt: clubImports.createdAt,
			appliedAt: clubImports.appliedAt,
			clubName: sql<string | null>`${clubImports.bundle} -> 'club' ->> 'name'`,
			meetings: sql<number>`coalesce(jsonb_array_length(${clubImports.bundle} -> 'meetings'), 0)`,
			reconciled: sql<
				string | null
			>`${clubImports.bundle} -> 'importState' -> 'report' ->> 'reconciled'`,
		})
		.from(clubImports)
		.where(eq(clubImports.clubId, clubId))
		.orderBy(sql`${clubImports.createdAt} desc`);
	return rows.map((r) => ({
		...r,
		meetings: Number(r.meetings),
		reconciled: r.reconciled === null ? null : r.reconciled === "true",
	}));
}

/**
 * The stored reconciliation report of an import in THIS club, or null when it
 * has not been applied. The club is part of the lookup, so an import id from
 * another club is simply not found.
 */
export async function loadImportReport(input: {
	clubId: string;
	importId?: string;
}): Promise<{
	importId: string;
	appliedAt: Date;
	report: ImportReport;
} | null> {
	const [row] = await db
		.select({
			importId: clubImports.id,
			appliedAt: clubImports.appliedAt,
			report: sql<unknown>`${clubImports.bundle} -> 'importState' -> 'report'`,
		})
		.from(clubImports)
		.where(
			and(
				eq(clubImports.clubId, input.clubId),
				isNotNull(clubImports.appliedAt),
				input.importId ? eq(clubImports.id, input.importId) : undefined,
			),
		)
		.orderBy(sql`${clubImports.appliedAt} desc`)
		.limit(1);
	if (!row?.appliedAt || !row.report) return null;
	return {
		importId: row.importId,
		appliedAt: row.appliedAt,
		report: row.report as ImportReport,
	};
}

// ---------------------------------------------------------------------------
// Plan context
// ---------------------------------------------------------------------------

interface LoadedContext {
	ctx: PlanContext;
	/** membership -> Person, for the speeches a member owns. */
	personByMember: Map<string, string>;
	club: {
		name: string;
		clubNumber: string | null;
		archivedAt: Date | null;
		defaultMeetingMinutes: number;
	};
}

async function loadPlanContext(
	clubId: string,
	now: Date,
	resolutions: Record<string, PersonResolution>,
): Promise<LoadedContext> {
	const [club] = await db
		.select({
			name: clubs.name,
			clubNumber: clubs.clubNumber,
			timezone: clubs.timezone,
			archivedAt: clubs.archivedAt,
			defaultMeetingMinutes: clubs.defaultMeetingMinutes,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");

	const [roster, defs, guestRows, meetingRows, refs] = await Promise.all([
		db
			.select({
				memberId: members.id,
				personId: members.personId,
				name: members.name,
			})
			.from(members)
			.where(eq(members.clubId, clubId))
			.orderBy(asc(members.name)),
		db
			.select({
				id: roleDefinitions.id,
				key: roleDefinitions.key,
				name: roleDefinitions.name,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, clubId)),
		db.select({ id: guests.id }).from(guests).where(eq(guests.clubId, clubId)),
		db
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				status: meetings.status,
			})
			.from(meetings)
			.where(eq(meetings.clubId, clubId))
			// Two meetings at one instant are chosen between by position (the first
			// adoptable, else the first blocker), so the order must not be the heap's.
			.orderBy(meetings.createdAt, meetings.id),
		db
			.select({
				kind: importRefs.kind,
				sourceId: importRefs.sourceId,
				targetId: importRefs.targetId,
			})
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, clubId),
					eq(importRefs.source, SOURCE),
					inArray(importRefs.kind, ["person", "guest", "meeting"]),
				),
			),
	]);

	return {
		ctx: {
			now,
			clubTimezone: club.timezone,
			roster: roster.map((m) => ({ memberId: m.memberId, name: m.name })),
			roleDefinitions: defs,
			guestIds: new Set(guestRows.map((g) => g.id)),
			existingMeetings: meetingRows,
			refs,
			resolutions,
		},
		personByMember: new Map(roster.map((m) => [m.memberId, m.personId])),
		club,
	};
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ImportPreviewPerson {
	key: string;
	name: string;
	esUserId: string | null;
	status: PlanPerson["outcome"]["status"];
	/** For `member`: how it was matched. For `guest`: why it is a guest. */
	via: string | null;
	memberId: string | null;
	kind: string | null;
	reason: string | null;
	candidates: PlanRosterMember[];
	rejectedChoice: string | null;
	appearances: PlanPerson["appearances"];
	/** On the member list, the mentor chart or the speech requests only: matched, never created (#1203). */
	listOnly: boolean;
	/** Whether the apply waits for a human's answer on this person. */
	needsDecision: boolean;
}

export interface ImportPreview {
	importId: string;
	/** Fingerprint of this plan: an apply that carries it is refused if the plan has moved. */
	planHash: string;
	appliedAt: string | null;
	bundleClub: { name: string; number: string | null };
	club: { name: string; number: string | null };
	warnings: string[];
	counts: PlanCounts;
	people: ImportPreviewPerson[];
	roleDefinitions: Array<{
		planKey: string;
		name: string;
		isNew: boolean;
		standardKey: string | null;
		labels: string[];
	}>;
	futureMeetings: ImportPlan["futureMeetings"];
	roster: PlanRosterMember[];
	unresolvedCount: number;
	canApply: boolean;
	savedResolutions: Record<string, PersonResolution>;
	report: ImportReport | null;
}

function previewPerson(p: PlanPerson): ImportPreviewPerson {
	const o = p.outcome;
	return {
		key: p.key,
		name: p.name,
		esUserId: p.esUserId,
		status: o.status,
		via: o.status === "member" || o.status === "guest" ? o.via : null,
		memberId: o.status === "member" ? o.memberId : null,
		kind: o.status === "guest" ? o.kind : null,
		reason: o.status === "skipped" ? o.reason : null,
		candidates: o.status === "ambiguous" ? o.candidates : [],
		rejectedChoice: p.rejectedChoice,
		appearances: p.appearances,
		listOnly: p.listOnly,
		needsDecision: needsDecision(p),
	};
}

/**
 * A fingerprint of what an apply would DO: who each person resolves to, which
 * role definitions exist, and what happens to each meeting. An apply that carries
 * the hash of the preview it confirmed is refused when its own plan, computed
 * under the import lock, hashes differently (a roster, a meeting or a ref moved
 * in between).
 */
export function planFingerprint(plan: ImportPlan): string {
	// Built apart from the hash call: `meeting-writers.guard.test.ts` reads any
	// `.update(` that names `meetings` as a database write.
	const canonical = JSON.stringify({
		people: plan.people.map((p) => [p.key, p.outcome]),
		roleDefinitions: plan.roleDefinitions.map((d) => [d.planKey, d.existingId]),
		meetings: plan.meetings.map((m) => [
			m.esMeetingId,
			m.scheduledAt.toISOString(),
			m.action,
			m.existingMeetingId,
			m.skip?.kind ?? null,
		]),
		counts: plan.counts,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/** The preview a superadmin confirms: the plan, summarised, plus any stored report. */
export async function previewEasySpeakImport(input: {
	clubId: string;
	importId: string;
	resolutions?: Record<string, PersonResolution>;
	now?: Date;
}): Promise<ImportPreview> {
	const stored = await loadStoredBundle(input.clubId, input.importId);
	const resolutions = resolutionsSchema.parse({
		...stored.state.resolutions,
		...input.resolutions,
	});
	const loaded = await loadPlanContext(
		input.clubId,
		input.now ?? new Date(),
		resolutions,
	);
	const plan = buildImportPlan(stored.bundle, loaded.ctx);
	const warnings: string[] = [];
	const { club } = stored.bundle;
	if (
		club.number &&
		loaded.club.clubNumber &&
		club.number !== loaded.club.clubNumber
	) {
		warnings.push(
			`The bundle is for club ${club.number} ("${club.name}") but this club's number is ${loaded.club.clubNumber}.`,
		);
	}
	if (isClubArchived(loaded.club)) warnings.push(CLUB_ARCHIVED_MESSAGE);
	return {
		importId: input.importId,
		planHash: planFingerprint(plan),
		appliedAt: stored.appliedAt?.toISOString() ?? null,
		bundleClub: { name: club.name, number: club.number },
		club: { name: loaded.club.name, number: loaded.club.clubNumber },
		warnings,
		counts: plan.counts,
		people: plan.people.map(previewPerson),
		roleDefinitions: plan.roleDefinitions.map((d) => ({
			planKey: d.planKey,
			name: d.name,
			isNew: !d.existingId,
			standardKey: d.standardKey,
			labels: d.labels,
		})),
		futureMeetings: plan.futureMeetings,
		roster: loaded.ctx.roster,
		unresolvedCount: plan.unresolved.length,
		canApply: plan.canApply,
		savedResolutions: stored.state.resolutions,
		report: stored.state.report,
	};
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** `club_id` and `source` are fixed; the kind is checked against `IMPORT_REF_KINDS`. */
export async function putRef(
	tx: Tx,
	clubId: string,
	kind: ImportRefKind,
	sourceId: string,
	targetId: string,
): Promise<void> {
	await tx
		.insert(importRefs)
		.values({
			clubId,
			source: SOURCE,
			kind: importRefKindSchema.parse(kind),
			sourceId,
			targetId,
		})
		.onConflictDoNothing();
}

/**
 * The member id a guest may name as its introducer, or a refusal. The column has
 * no database check that the member is in the guest's club, so this is the check:
 * it asks, in the transaction that is about to write.
 */
export async function validatedIntroducerId(
	tx: Tx,
	clubId: string,
	memberId: string,
): Promise<string> {
	const [row] = await tx
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error(INTRODUCER_NOT_IN_CLUB_MESSAGE);
	return row.id;
}

type Owner = { memberId: string } | { guestId: string } | null;

interface Resolved {
	members: Map<string, string>;
	guests: Map<string, string>;
	/** Person keys an earlier import named and a human has since deleted (D2). */
	deleted: Set<string>;
	roleDefIds: Map<string, string>;
	newGuests: number;
	newRoleDefinitions: string[];
}

/** People, then role definitions: everything every meeting needs, written once. */
export async function writePeopleAndRoles(
	clubId: string,
	plan: ImportPlan,
): Promise<Resolved> {
	return db.transaction(async (tx) => {
		await lockClubForWrite(tx, clubId);
		await assertClubNotArchivedTx(tx, clubId);
		const out: Resolved = {
			members: new Map(),
			guests: new Map(),
			deleted: new Set(),
			roleDefIds: new Map(),
			newGuests: 0,
			newRoleDefinitions: [],
		};

		const [top] = await tx
			.select({
				max: sql<number>`coalesce(max(${roleDefinitions.sortOrder}), 0)`,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, clubId));
		let sortOrder = Number(top?.max ?? 0);
		const nextSortOrder = () => {
			sortOrder += 10;
			return sortOrder;
		};
		for (const def of plan.roleDefinitions) {
			if (def.existingId) {
				out.roleDefIds.set(def.planKey, def.existingId);
				continue;
			}
			const seed = def.standardKey
				? ROLE_TEMPLATE.find((r) => r.key === def.standardKey)
				: undefined;
			// History is not the club's standing meeting shape: neither a standard
			// role seeded for an old meeting nor a role the club once ran in
			// Easy-Speak may start generating an open slot on every new meeting.
			const [inserted] = await tx
				.insert(roleDefinitions)
				.values(
					seed
						? {
								clubId,
								name: seed.name,
								category: seed.category,
								defaultCount: seed.defaultCount,
								sortOrder: seed.sortOrder,
								isSpeakerRole: seed.isSpeakerRole,
								description: seed.description,
								beforeNotes: seed.beforeNotes,
								duringNotes: seed.duringNotes,
								key: seed.key,
								standing: false,
							}
						: {
								clubId,
								name: def.name,
								category: "functionary",
								defaultCount: 1,
								sortOrder: nextSortOrder(),
								isSpeakerRole: false,
								standing: false,
							},
				)
				// Two imports (or an officer) minting the same standard key at once:
				// `role_definitions_club_key_unique` settles it, and the loser reads the
				// winner's row instead of failing the whole setup.
				.onConflictDoNothing()
				.returning({ id: roleDefinitions.id });
			let created = inserted;
			const minted = Boolean(inserted);
			if (!created && seed) {
				[created] = await tx
					.select({ id: roleDefinitions.id })
					.from(roleDefinitions)
					.where(
						and(
							eq(roleDefinitions.clubId, clubId),
							eq(roleDefinitions.key, seed.key),
						),
					)
					.limit(1);
			}
			if (!created) throw new Error("Could not create a role definition.");
			out.roleDefIds.set(def.planKey, created.id);
			if (minted) out.newRoleDefinitions.push(def.name);
		}

		const introducerOf = new Map<string, string>();
		for (const intro of plan.introductions) {
			if (introducerOf.has(intro.visitorKey)) continue;
			introducerOf.set(intro.visitorKey, intro.introducerKey);
		}
		const byKey = new Map(plan.people.map((p) => [p.key, p]));

		for (const person of plan.people) {
			const o = person.outcome;
			if (o.status === "member") {
				out.members.set(person.key, o.memberId);
				await putRef(tx, clubId, "person", person.key, o.memberId);
			} else if (o.status === "deleted") {
				out.deleted.add(person.key);
			} else if (o.status === "guest") {
				if (o.guestId) {
					out.guests.set(person.key, o.guestId);
					continue;
				}
				// The plan never makes a guest of a person no meeting names (#1203);
				// this is the second lock on that door.
				if (person.listOnly) continue;
				let introducedByMemberId: string | null = null;
				const introducer = byKey.get(introducerOf.get(person.key) ?? "");
				if (introducer?.outcome.status === "member") {
					introducedByMemberId = await validatedIntroducerId(
						tx,
						clubId,
						introducer.outcome.memberId,
					);
				}
				const created = await createGuestRecord(tx, {
					clubId,
					name: person.name,
					kind: o.kind,
					homeClub: null,
					introducedByMemberId,
					// History is not a pipeline: a name from years of Easy-Speak lists must
					// not land in VP Membership's prospects.
					stage: "lost",
				});
				out.guests.set(person.key, created.id);
				out.newGuests++;
				await putRef(tx, clubId, "guest", person.key, created.id);
			}
		}
		return out;
	});
}

interface MeetingEnv {
	clubId: string;
	now: Date;
	lengthMinutes: number;
	resolved: Resolved;
	personByMember: Map<string, string>;
}

const ownerOf = (env: MeetingEnv, key: string | null): Owner => {
	if (!key) return null;
	const memberId = env.resolved.members.get(key);
	if (memberId) return { memberId };
	const guestId = env.resolved.guests.get(key);
	if (guestId) return { guestId };
	return null;
};

/** A person an earlier import named and a human has since deleted (D2): nothing of theirs is written. */
const isTombstoned = (env: MeetingEnv, key: string | null): boolean =>
	key !== null && env.resolved.deleted.has(key);

/** Which of `ids` still name a row of `column`'s table: a ref to a row that is gone is a tombstone. */
async function stillThere(
	tx: Tx,
	column: AnyPgColumn,
	ids: string[],
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const rows = await tx
		.select({ id: column })
		.from(column.table as PgTable)
		.where(inArray(column, ids));
	return new Set(rows.map((r) => String(r.id)));
}

/** What one meeting's transaction did: written, or left alone, and what it left out on purpose. */
interface MeetingOutcome {
	applied: boolean;
	omissions: Omission[];
}

/** One meeting, in its own transaction: all of it, or none of it. */
async function applyMeeting(
	env: MeetingEnv,
	pm: PlanMeeting,
): Promise<MeetingOutcome> {
	const { clubId } = env;
	const omissions: Omission[] = [];
	const omit = (
		kind: Omission["kind"],
		sourceId: string,
		cause: { what: string; reason: string } = DELETED_SINCE_IMPORT,
	) => {
		omissions.push({ kind, sourceId, ...cause });
	};
	let applied = true;
	await db.transaction(async (tx) => {
		await lockClubForWrite(tx, clubId);
		await assertClubNotArchivedTx(tx, clubId);

		// -- The meeting row --------------------------------------------------
		const joinUrl = normalizePresentationUrl(pm.joinUrl);
		let meetingId: string;
		let m: typeof meetings.$inferSelect | undefined;
		if (pm.existingMeetingId) {
			[m] = await tx
				.select()
				.from(meetings)
				.where(
					and(
						eq(meetings.id, pm.existingMeetingId),
						eq(meetings.clubId, clubId),
					),
				)
				.limit(1)
				.for("no key update");
			if (!m) throw new Error("The meeting this import points at is gone.");
		} else {
			// The plan said "create", but it was read before this lock: a person may
			// have made a meeting at this instant since. Under the lock, D1 applies to
			// it as it would have in the plan (adopt a completed one, leave any other
			// alone) rather than minting a second meeting at the same instant.
			const atInstant = await tx
				.select()
				.from(meetings)
				.where(
					and(
						eq(meetings.clubId, clubId),
						eq(meetings.scheduledAt, pm.scheduledAt),
					),
				)
				.orderBy(meetings.createdAt, meetings.id)
				.for("no key update");
			m =
				atInstant.find(
					(x) =>
						x.status === "completed" &&
						x.scheduledAt.getTime() <= env.now.getTime(),
				) ?? atInstant[0];
		}
		if (m) {
			// D1 of #1196: a meeting that is not a completed one in the past is left
			// exactly as it is. The plan said so too, but it was read before the
			// lock, and a meeting can be cancelled or rescheduled in between.
			if (
				m.status !== "completed" ||
				m.scheduledAt.getTime() > env.now.getTime()
			) {
				omit("meeting", pm.esMeetingId, {
					what: MEETING_LEFT_ALONE,
					reason: leftAloneReason(m.status),
				});
				applied = false;
				return;
			}
			// A completed meeting accepts record writes (the guard's `record` class).
			assertMeetingAccepts(m.status, "record");
			meetingId = m.id;
			// Fill a blank, nothing else: the status is not ours to change.
			await tx
				.update(meetings)
				.set({
					location: m.location ?? pm.venue,
					joinUrl: m.joinUrl ?? joinUrl,
					theme: m.theme ?? pm.theme,
					wordOfTheDay: m.wordOfTheDay ?? pm.wordOfTheDay,
				})
				.where(eq(meetings.id, m.id));
		} else {
			// Created as a completed past meeting from the start: it never passes
			// through a status a writer would refuse.
			const [created] = await tx
				.insert(meetings)
				.values({
					clubId,
					scheduledAt: pm.scheduledAt,
					lengthMinutes: env.lengthMinutes,
					status: "completed",
					location: pm.venue,
					joinUrl,
					theme: pm.theme,
					wordOfTheDay: pm.wordOfTheDay,
				})
				.returning({ id: meetings.id });
			if (!created) throw new Error("Could not create the meeting.");
			meetingId = created.id;
		}
		await putRef(tx, clubId, "meeting", pm.esMeetingId, meetingId);

		// -- Refs this meeting already has ------------------------------------
		const sourceIds = [
			...pm.slots.map((s) => s.sourceId),
			...pm.slots.flatMap((s) => (s.speech ? [s.speech.sourceId] : [])),
			...pm.attendance.map((a) => a.sourceId),
			...pm.awards.map((a) => a.sourceId),
			...pm.tableTopics.map((t) => t.sourceId),
		];
		const refRows =
			sourceIds.length === 0
				? []
				: await tx
						.select({
							kind: importRefs.kind,
							sourceId: importRefs.sourceId,
							targetId: importRefs.targetId,
						})
						.from(importRefs)
						.where(
							and(
								eq(importRefs.clubId, clubId),
								eq(importRefs.source, SOURCE),
								inArray(importRefs.sourceId, sourceIds),
							),
						);
		const refOf = (kind: ImportRefKind, sourceId: string) =>
			refRows.find((r) => r.kind === kind && r.sourceId === sourceId)?.targetId;
		const targetsOf = (kind: ImportRefKind) =>
			refRows.filter((r) => r.kind === kind).map((r) => r.targetId);
		// A ref whose row is gone: a human deleted it since the import. Never re-made.
		const keptSpeeches = await stillThere(tx, speeches.id, targetsOf("speech"));
		const keptAttendance = await stillThere(
			tx,
			meetingAttendance.id,
			targetsOf("attendance"),
		);
		const keptAwards = await stillThere(
			tx,
			meetingAwards.id,
			targetsOf("award"),
		);
		const keptTopics = await stillThere(
			tx,
			tableTopicsSpeakers.id,
			targetsOf("table_topic"),
		);

		// -- Role slots and their speeches -------------------------------------
		const existingSlots = await tx
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, meetingId));
		const used = new Set<string>();
		const slotIdByEsSlot = new Map<number, string>();
		for (const ps of pm.slots) {
			const roleDefinitionId = env.resolved.roleDefIds.get(ps.roleKey);
			if (!roleDefinitionId)
				throw new Error(`No role definition for ${ps.label}.`);
			const owner = ownerOf(env, ps.holderKey);
			const refTarget = refOf("role_slot", ps.sourceId);
			const holderDeleted = isTombstoned(env, ps.holderKey);
			if (refTarget && !existingSlots.some((s) => s.id === refTarget)) {
				// This role slot was imported and has been deleted since.
				if (ps.holderKey) omit("roleAssignment", ps.sourceId);
				if (ps.holderKey && ps.speech) omit("speech", ps.speech.sourceId);
				continue;
			}
			if (holderDeleted) {
				omit("roleAssignment", ps.sourceId);
				if (ps.speech) omit("speech", ps.speech.sourceId);
			}
			let slot =
				existingSlots.find((s) => s.id === refTarget && !used.has(s.id)) ??
				existingSlots.find(
					(s) =>
						!used.has(s.id) &&
						s.roleDefinitionId === roleDefinitionId &&
						s.slotIndex === ps.slotIndex,
				);
			const assignment = owner
				? "memberId" in owner
					? { assignedMemberId: owner.memberId, assignedGuestId: null }
					: { assignedMemberId: null, assignedGuestId: owner.guestId }
				: { assignedMemberId: null, assignedGuestId: null };
			if (!slot) {
				const [created] = await tx
					.insert(roleSlots)
					.values({
						meetingId,
						roleDefinitionId,
						slotIndex: ps.slotIndex,
						status: owner ? "confirmed" : "open",
						...assignment,
					})
					.returning();
				if (!created) throw new Error("Could not create a role slot.");
				slot = created;
			} else if (
				owner &&
				slot.assignedMemberId === null &&
				slot.assignedGuestId === null
			) {
				// Only a slot that is STILL empty: a member or guest who claimed it since
				// the read above keeps it, and the row is read again to say so.
				const [updated] = await tx
					.update(roleSlots)
					.set({ status: "confirmed", ...assignment })
					.where(
						and(
							eq(roleSlots.id, slot.id),
							isNull(roleSlots.assignedMemberId),
							isNull(roleSlots.assignedGuestId),
						),
					)
					.returning();
				if (updated) {
					slot = updated;
				} else {
					const [current] = await tx
						.select()
						.from(roleSlots)
						.where(eq(roleSlots.id, slot.id))
						.limit(1);
					slot = current ?? slot;
				}
			}
			used.add(slot.id);
			slotIdByEsSlot.set(ps.esSlot, slot.id);
			// The ref is only written for a slot that is the bundle's: held by the
			// bundle's holder, or empty where the bundle has none. A slot someone else
			// holds is theirs; a ref to it would turn its later deletion into "the
			// import's role deleted" and the bundle's holder would never be seated.
			const slotIsBundles = owner
				? sameOwner(owner, slot.assignedMemberId, slot.assignedGuestId)
				: slot.assignedMemberId === null && slot.assignedGuestId === null;
			if (slotIsBundles) {
				await putRef(tx, clubId, "role_slot", ps.sourceId, slot.id);
			}

			// A speech sits on the slot of the one who owns it: a member's on a slot
			// that member holds, a guest's on a slot that guest holds, and never the
			// other way about. A slot someone else already holds gets no speech.
			const holds =
				owner &&
				("memberId" in owner
					? slot.assignedMemberId === owner.memberId
					: slot.assignedGuestId === owner.guestId);
			if (ps.speech && owner && holds && !slot.speechId) {
				const speechRef = refOf("speech", ps.speech.sourceId);
				let speechId: string | undefined;
				if (speechRef && !keptSpeeches.has(speechRef)) {
					// The imported speech was deleted since: not written again.
					omit("speech", ps.speech.sourceId);
				} else if (speechRef) {
					speechId = speechRef;
				} else {
					let ownerColumns: { personId: string } | { guestId: string };
					if ("memberId" in owner) {
						const personId = env.personByMember.get(owner.memberId);
						if (!personId) throw new Error("A member has no Person.");
						ownerColumns = { personId };
					} else {
						ownerColumns = { guestId: owner.guestId };
					}
					const [created] = await tx
						.insert(speeches)
						.values({
							...ownerColumns,
							title: ps.speech.title,
							introduction: ps.speech.introduction,
							pathwayPath: ps.speech.path,
							projectName: ps.speech.project,
							projectLevel: ps.speech.level,
							minMinutes: ps.speech.minMinutes,
							maxMinutes: ps.speech.maxMinutes,
						})
						.returning({ id: speeches.id });
					if (!created) throw new Error("Could not create a speech.");
					speechId = created.id;
					await putRef(tx, clubId, "speech", ps.speech.sourceId, speechId);
				}
				if (speechId) {
					await tx
						.update(roleSlots)
						.set({ speechId })
						.where(
							and(
								eq(roleSlots.id, slot.id),
								sql`${roleSlots.speechId} is null`,
							),
						);
				}
			}
		}
		// Evaluator -> the speaker slot it evaluates, once every slot exists.
		for (const ps of pm.slots) {
			if (ps.evaluatesEsSlot === null) continue;
			const evaluator = slotIdByEsSlot.get(ps.esSlot);
			const speaker = slotIdByEsSlot.get(ps.evaluatesEsSlot);
			if (!evaluator || !speaker) continue;
			await tx
				.update(roleSlots)
				.set({ evaluatesSlotId: speaker })
				.where(
					and(
						eq(roleSlots.id, evaluator),
						sql`${roleSlots.evaluatesSlotId} is null`,
					),
				);
		}

		// -- Attendance, and the plan answers a record does not supersede ------
		for (const a of pm.attendance) {
			if (isTombstoned(env, a.personKey)) {
				omit("attendance", a.sourceId);
				continue;
			}
			const owner = ownerOf(env, a.personKey);
			if (!owner) continue;
			const attendanceRef = refOf("attendance", a.sourceId);
			if (attendanceRef && !keptAttendance.has(attendanceRef)) {
				omit("attendance", a.sourceId);
				continue;
			}
			const where =
				"memberId" in owner
					? and(
							eq(meetingAttendance.meetingId, meetingId),
							eq(meetingAttendance.memberId, owner.memberId),
						)
					: and(
							eq(meetingAttendance.meetingId, meetingId),
							eq(meetingAttendance.guestId, owner.guestId),
						);
			await tx
				.insert(meetingAttendance)
				.values({
					meetingId,
					status: "present",
					mode: a.mode,
					...("memberId" in owner
						? { memberId: owner.memberId }
						: { guestId: owner.guestId }),
				})
				.onConflictDoNothing();
			const [row] = await tx
				.select({ id: meetingAttendance.id })
				.from(meetingAttendance)
				.where(where)
				.limit(1);
			if (row) await putRef(tx, clubId, "attendance", a.sourceId, row.id);
		}
		// The plan table is keyed on a membership: a guest has no plan row. The seam
		// fills only what is absent and logs nothing (D3 of #1196). Plan answers
		// carry no import ref, so they are written only on the FIRST apply of a
		// meeting (it is created or adopted now): on a re-run ("update") an answer
		// a human has since cleared would otherwise come back.
		const planAnswers: Array<{
			memberId: string;
			status: (typeof pm.plans)[number]["status"];
		}> = [];
		for (const p of pm.plans) {
			const owner = ownerOf(env, p.personKey);
			if (!owner || !("memberId" in owner)) continue;
			planAnswers.push({ memberId: owner.memberId, status: p.status });
		}
		if (pm.action !== "update") {
			await importPlanAnswers(tx, { meetingId, answers: planAnswers });
		}

		// -- Awards, Table Topics -----------------------------------------------
		for (const a of pm.awards) {
			if (isTombstoned(env, a.personKey)) {
				omit("award", a.sourceId);
				continue;
			}
			const owner = ownerOf(env, a.personKey);
			if (!owner) continue;
			const awardRef = refOf("award", a.sourceId);
			if (awardRef && !keptAwards.has(awardRef)) {
				omit("award", a.sourceId);
				continue;
			}
			await tx
				.insert(meetingAwards)
				.values({
					meetingId,
					category: a.category,
					...("memberId" in owner
						? { memberId: owner.memberId }
						: { guestId: owner.guestId }),
				})
				.onConflictDoNothing();
			const [row] = await tx
				.select({
					id: meetingAwards.id,
					memberId: meetingAwards.memberId,
					guestId: meetingAwards.guestId,
				})
				.from(meetingAwards)
				.where(
					and(
						eq(meetingAwards.meetingId, meetingId),
						eq(meetingAwards.category, a.category),
					),
				)
				.limit(1);
			// A ref says "the import made this row". An award someone else holds is
			// not that: written, it would read as the import's own award deleted the
			// moment an officer clears it, and Alice's would never come back.
			if (row && sameOwner(owner, row.memberId, row.guestId)) {
				await putRef(tx, clubId, "award", a.sourceId, row.id);
			}
		}
		for (const t of pm.tableTopics) {
			if (isTombstoned(env, t.personKey)) {
				omit("tableTopic", t.sourceId);
				continue;
			}
			const owner = ownerOf(env, t.personKey);
			if (!owner) continue;
			const topicRef = refOf("table_topic", t.sourceId);
			if (topicRef) {
				if (!keptTopics.has(topicRef)) omit("tableTopic", t.sourceId);
				continue;
			}
			const [row] = await tx
				.insert(tableTopicsSpeakers)
				.values({
					meetingId,
					topic: t.topic,
					sortOrder: t.sortOrder,
					...("memberId" in owner
						? { memberId: owner.memberId }
						: { guestId: owner.guestId }),
				})
				.returning({ id: tableTopicsSpeakers.id });
			if (row) await putRef(tx, clubId, "table_topic", t.sourceId, row.id);
		}
	});
	return { applied, omissions };
}

/** What a failed meeting says in the report: never the SQL, which carries names. */
export function describeFailure(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/^Failed query/u.test(message)) {
		const cause = (err as { cause?: { message?: string; code?: string } })
			.cause;
		return scrubJsonbText(
			`Database error${cause?.code ? ` ${cause.code}` : ""}: ${scrubJsonbText(cause?.message ?? "the statement was refused", 200)}`,
		);
	}
	return scrubJsonbText(message, 300);
}

/** Who the bundle says holds a role slot or won an award, by the ref's source id. */
interface ExpectedHolders {
	slots: Map<string, Owner>;
	awards: Map<string, Owner>;
}

const sameOwner = (a: Owner, member: string | null, guest: string | null) =>
	a !== null && ("memberId" in a ? a.memberId === member : a.guestId === guest);

/**
 * The source ids an apply left behind, read back from the database, by what
 * qualifies. A role assignment counts only when the slot is held by the person
 * the bundle names, and an award only when that person holds it: a slot someone
 * else already held, or an award already given to another, is a difference.
 */
async function loadFoundSourceIds(
	clubId: string,
	expected: ExpectedHolders,
): Promise<FoundSourceIds> {
	const scope = (kind: ImportRefKind) =>
		and(
			eq(importRefs.clubId, clubId),
			eq(importRefs.source, SOURCE),
			eq(importRefs.kind, kind),
		);
	const ids = (rows: Array<{ sourceId: string }>) =>
		new Set(rows.map((r) => r.sourceId));
	const [
		meeting,
		roleAssignment,
		speech,
		speechIntro,
		award,
		tableTopic,
		attendance,
	] = await Promise.all([
		db
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.innerJoin(meetings, eq(meetings.id, importRefs.targetId))
			.where(and(scope("meeting"), eq(meetings.status, "completed"))),
		db
			.select({
				sourceId: importRefs.sourceId,
				member: roleSlots.assignedMemberId,
				guest: roleSlots.assignedGuestId,
			})
			.from(importRefs)
			.innerJoin(roleSlots, eq(roleSlots.id, importRefs.targetId))
			.where(
				and(
					scope("role_slot"),
					or(
						isNotNull(roleSlots.assignedMemberId),
						isNotNull(roleSlots.assignedGuestId),
					),
				),
			),
		db
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.innerJoin(speeches, eq(speeches.id, importRefs.targetId))
			.where(scope("speech")),
		db
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.innerJoin(speeches, eq(speeches.id, importRefs.targetId))
			.where(
				and(
					scope("speech"),
					sql`btrim(coalesce(${speeches.introduction}, '')) <> ''`,
				),
			),
		db
			.select({
				sourceId: importRefs.sourceId,
				member: meetingAwards.memberId,
				guest: meetingAwards.guestId,
			})
			.from(importRefs)
			.innerJoin(meetingAwards, eq(meetingAwards.id, importRefs.targetId))
			.where(scope("award")),
		db
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.innerJoin(
				tableTopicsSpeakers,
				eq(tableTopicsSpeakers.id, importRefs.targetId),
			)
			.where(scope("table_topic")),
		db
			.select({ sourceId: importRefs.sourceId })
			.from(importRefs)
			.innerJoin(
				meetingAttendance,
				eq(meetingAttendance.id, importRefs.targetId),
			)
			.where(and(scope("attendance"), eq(meetingAttendance.status, "present"))),
	]);
	return {
		meeting: ids(meeting),
		roleAssignment: ids(
			roleAssignment.filter((r) =>
				sameOwner(expected.slots.get(r.sourceId) ?? null, r.member, r.guest),
			),
		),
		speech: ids(speech),
		speechWithIntroduction: ids(speechIntro),
		award: ids(
			award.filter((r) =>
				sameOwner(expected.awards.get(r.sourceId) ?? null, r.member, r.guest),
			),
		),
		tableTopic: ids(tableTopic),
		attendance: ids(attendance),
	};
}

export interface ApplyResult {
	report: ImportReport;
}

/**
 * The per-club history-import lock: ONE apply (or speech-request apply) per club
 * at a time. It TRIES the lock and refuses at once rather than waiting, because
 * the holder keeps a pooled connection for its whole run. Held until `tx` ends.
 */
export async function takeImportLock(tx: Tx, clubId: string): Promise<void> {
	const taken = await tx.execute<{ ok: boolean }>(
		sql`select pg_try_advisory_xact_lock(hashtextextended(${`history-import:${clubId}`}, 0)) as ok`,
	);
	if (!taken.rows[0]?.ok) throw new Error(IMPORT_RUNNING_MESSAGE);
}

/**
 * Apply a stored bundle to its club. The caller has proved the superadmin.
 *
 * Refused while any person is unresolved, and for an archived club. Re-running is
 * safe: see the module header. Returns the stored report.
 */
export async function applyEasySpeakImport(input: {
	clubId: string;
	importId: string;
	/** The superadmin the change is attributed to. */
	superadminUserId: string;
	resolutions?: Record<string, PersonResolution>;
	/** The `planHash` of the preview the superadmin confirmed; a plan that has moved is refused. */
	planHash?: string;
	now?: Date;
}): Promise<ApplyResult> {
	// ONE apply per club at a time, held for the whole run by a transaction that
	// does nothing else. The per-meeting transactions take the club write lock
	// themselves, so this is a DIFFERENT key (a bigint, `history-import:<club>`):
	// a second apply is refused at once instead of both planning the same new
	// guests and meetings and minting them twice. It TRIES the lock rather than
	// waiting on it: this transaction holds a pooled connection for the whole run
	// and the work inside opens more (#806: a wait with no timeout is a self-DoS
	// on a pool with no checkout timeout), so a queued apply would starve the run
	// it is queued behind.
	return db.transaction(async (guard) => {
		await takeImportLock(guard, input.clubId);
		return applyUnderImportLock(input);
	});
}

async function applyUnderImportLock(input: {
	clubId: string;
	importId: string;
	superadminUserId: string;
	resolutions?: Record<string, PersonResolution>;
	planHash?: string;
	now?: Date;
}): Promise<ApplyResult> {
	const now = input.now ?? new Date();
	const stored = await loadStoredBundle(input.clubId, input.importId);
	// The server fn parses these too; the logic does not trust its caller, because
	// a NUL or an unpaired surrogate in a key or a reason aborts the jsonb write
	// AFTER the meetings have landed.
	const resolutions = resolutionsSchema.parse({
		...stored.state.resolutions,
		...input.resolutions,
	});
	const loaded = await loadPlanContext(input.clubId, now, resolutions);
	if (isClubArchived(loaded.club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
	const plan = buildImportPlan(stored.bundle, loaded.ctx);
	if (!plan.canApply) {
		throw new Error(UNRESOLVED_PEOPLE_MESSAGE(plan.unresolved.length));
	}
	if (
		input.planHash !== undefined &&
		input.planHash !== planFingerprint(plan)
	) {
		throw new Error(PLAN_CHANGED_MESSAGE);
	}

	const resolved = await writePeopleAndRoles(input.clubId, plan);
	const env: MeetingEnv = {
		clubId: input.clubId,
		now,
		lengthMinutes: loaded.club.defaultMeetingMinutes,
		resolved,
		personByMember: loaded.personByMember,
	};
	const failed: Array<{ esMeetingId: string; message: string }> = [];
	const omissions: Omission[] = [];
	let appliedMeetings = 0;
	for (const pm of [...plan.meetings].sort(
		(a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime(),
	)) {
		if (pm.action === "skip" && pm.skip) {
			omissions.push({
				kind: "meeting",
				sourceId: pm.esMeetingId,
				what:
					pm.skip.kind === "deleted"
						? DELETED_SINCE_IMPORT.what
						: MEETING_LEFT_ALONE,
				reason: pm.skip.reason,
			});
			continue;
		}
		try {
			const outcome = await applyMeeting(env, pm);
			omissions.push(...outcome.omissions);
			if (outcome.applied) appliedMeetings++;
		} catch (err) {
			failed.push({
				esMeetingId: pm.esMeetingId,
				message: describeFailure(err),
			});
		}
	}

	const expected: ExpectedHolders = { slots: new Map(), awards: new Map() };
	for (const pm of plan.meetings) {
		for (const ps of pm.slots) {
			const owner = ownerOf(env, ps.holderKey);
			if (owner) expected.slots.set(ps.sourceId, owner);
		}
		for (const a of pm.awards) {
			const owner = ownerOf(env, a.personKey);
			if (owner) expected.awards.set(a.sourceId, owner);
		}
	}
	const found = await loadFoundSourceIds(input.clubId, expected);
	const report = buildReconciliation({
		bundle: stored.bundle,
		bundleSha256: stored.bundleSha256,
		now,
		clubTimezone: loaded.ctx.clubTimezone,
		found,
		failed,
		appliedMeetings,
		skippedPeople: plan.people.flatMap((p) =>
			p.outcome.status === "skipped"
				? [{ key: p.key, name: p.name, reason: p.outcome.reason }]
				: [],
		),
		created: {
			guests: resolved.newGuests,
			roleDefinitions: resolved.newRoleDefinitions,
		},
		omissions,
	});

	const importState = JSON.stringify({ resolutions, report });
	await db.transaction(async (tx) => {
		await tx
			.update(clubImports)
			.set({
				appliedAt: now,
				bundle: sql`${clubImports.bundle} || jsonb_build_object('importState', ${importState}::jsonb)`,
			})
			.where(
				and(
					eq(clubImports.id, input.importId),
					eq(clubImports.clubId, input.clubId),
				),
			);
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: null,
			// The superadmin is memberless in the club: attributed through the
			// impersonation column, as every other superadmin write is.
			impersonatedBy: input.superadminUserId,
			action: "history_imported",
			targetType: "club",
			targetId: input.clubId,
			detail: {
				importId: input.importId,
				source: SOURCE,
				reconciled: report.reconciled,
				failedMeetings: report.meetings.failed.length,
				counts: Object.fromEntries(
					report.counts.map((c) => [
						c.key,
						{ bundle: c.bundle, gavelup: c.gavelup },
					]),
				),
			},
		});
	});
	return { report };
}

// ---------------------------------------------------------------------------
// Speech requests (#1052): a step of its own, after the history is applied
// ---------------------------------------------------------------------------

export const IMPORT_NOT_APPLIED_MESSAGE =
	"Apply the import before importing its speech requests: they are matched to the people it resolved.";

/** What the speech-request step did, by outcome. The counts sum to `total`. */
export interface SpeechRequestImportResult {
	/** Requests in the bundle. */
	total: number;
	/** Rows this run created. */
	imported: number;
	/** Already imported by an earlier run (a row a human has since withdrawn or deleted stays that way). */
	alreadyImported: number;
	/** Left to the meeting history: Easy-Speak had already put them on a date. */
	skippedScheduled: number;
	/** Left to the meeting history: the speech was given. */
	skippedCompleted: number;
	/** A status this importer does not know. */
	skippedUnknownStatus: number;
	/** The requester is not an ACTIVE member this import resolved (a guest, skipped, removed or lapsed since). */
	skippedNoMember: number;
}

/**
 * The source id of one request. Easy-Speak's own id when the page had one; else
 * a hash of what identifies the ask (who, when, what), numbered when the same
 * ask appears twice, so a re-run reproduces the same ids in the same order.
 */
function speechRequestSourceId(
	request: EasySpeakBundleV1["speechRequests"][number],
	seen: Map<string, number>,
): string {
	if (request.esSpeechId) return request.esSpeechId;
	const identity = [
		personKeyOf(request.who),
		request.requestedOn ?? "",
		request.title ?? "",
		request.path ?? "",
		request.project ?? "",
		request.preferred.join(","),
	].join("|");
	const nth = (seen.get(identity) ?? 0) + 1;
	seen.set(identity, nth);
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
	return `anon:${hash}:${nth}`;
}

/**
 * Import the stored bundle's OPEN speech requests as queue rows. The caller has
 * proved the superadmin.
 *
 * - `requested` becomes an open request. `scheduled` and `completed` are skipped
 *   (the meeting history carries them) and counted.
 * - The requester must resolve through the `person` refs the import's apply
 *   wrote, to a member who is still ACTIVE in the club; anyone else (a former member
 *   included) is skipped, counted.
 * - Idempotent through `import_refs` kind `speech_request`: a second run adds
 *   nothing, and a request someone withdrew or deleted since is not brought back.
 * - One transaction under the club write lock and the apply's own per-club lock,
 *   so it never interleaves with an apply or another run: all or nothing.
 */
export async function importSpeechRequests(input: {
	clubId: string;
	importId: string;
	/** The superadmin the change is attributed to. */
	superadminUserId: string;
	now?: Date;
}): Promise<SpeechRequestImportResult> {
	const now = input.now ?? new Date();
	const stored = await loadStoredBundle(input.clubId, input.importId);
	if (!stored.appliedAt) throw new Error(IMPORT_NOT_APPLIED_MESSAGE);
	const requests = stored.bundle.speechRequests;

	return db.transaction(async (tx) => {
		await takeImportLock(tx, input.clubId);
		await lockClubForWrite(tx, input.clubId);
		await assertClubNotArchivedTx(tx, input.clubId);

		const refs = await tx
			.select({
				kind: importRefs.kind,
				sourceId: importRefs.sourceId,
				targetId: importRefs.targetId,
			})
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, input.clubId),
					eq(importRefs.source, SOURCE),
					inArray(importRefs.kind, ["person", "speech_request"]),
				),
			);
		const personRefs = new Map<string, string>();
		const imported = new Set<string>();
		for (const ref of refs) {
			if (ref.kind === "person") personRefs.set(ref.sourceId, ref.targetId);
			else imported.add(ref.sourceId);
		}
		// ACTIVE members only: the queue lists only those, so a request imported for
		// a former member would be an invisible row nobody can schedule or withdraw.
		const live = new Set(
			(
				await tx
					.select({ id: members.id })
					.from(members)
					.where(
						and(eq(members.clubId, input.clubId), eq(members.status, "active")),
					)
			).map((m) => m.id),
		);

		const result: SpeechRequestImportResult = {
			total: requests.length,
			imported: 0,
			alreadyImported: 0,
			skippedScheduled: 0,
			skippedCompleted: 0,
			skippedUnknownStatus: 0,
			skippedNoMember: 0,
		};
		const seen = new Map<string, number>();
		for (const request of requests) {
			// The id is taken for EVERY request, skipped or not, so an unkeyed
			// request's number does not depend on which of its twins were skipped.
			const sourceId = speechRequestSourceId(request, seen);
			const status = request.status.trim().toLowerCase();
			if (status === "scheduled") {
				result.skippedScheduled++;
				continue;
			}
			if (status === "completed") {
				result.skippedCompleted++;
				continue;
			}
			if (status !== "requested") {
				result.skippedUnknownStatus++;
				continue;
			}
			const memberId = personRefs.get(personKeyOf(request.who));
			if (!memberId || !live.has(memberId)) {
				result.skippedNoMember++;
				continue;
			}
			if (imported.has(sourceId)) {
				result.alreadyImported++;
				continue;
			}
			const [row] = await tx
				.insert(speechRequests)
				.values({
					clubId: input.clubId,
					membershipId: memberId,
					title: clipImportedText(request.title, "title"),
					path: clipImportedText(request.path, "path"),
					projectName: clipImportedText(request.project, "projectName"),
					introduction: clipImportedText(request.introduction, "introduction"),
					preferredDates: normalizePreferredDates(request.preferred),
					createdAt: request.requestedOn
						? new Date(`${request.requestedOn}T12:00:00.000Z`)
						: now,
				})
				.returning({ id: speechRequests.id });
			if (!row) throw new Error("Could not create a speech request.");
			await putRef(tx, input.clubId, "speech_request", sourceId, row.id);
			imported.add(sourceId);
			result.imported++;
		}

		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: null,
			impersonatedBy: input.superadminUserId,
			action: "history_imported",
			targetType: "club",
			targetId: input.clubId,
			detail: {
				importId: input.importId,
				source: SOURCE,
				step: "speech_requests",
				counts: result,
			},
		});
		return result;
	});
}

// ---------------------------------------------------------------------------
// Server-fn inputs (kept here: history-import.ts may export only server fns)
// ---------------------------------------------------------------------------

export const importClubSchema = z.object({ clubId: z.string().uuid() });
export const uploadImportSchema = importClubSchema.extend({
	/** The bundle's JSON text, as read from the file. The logic enforces the cap. */
	text: z.string().min(1, "Choose a file to upload."),
});
export const importRunSchema = importClubSchema.extend({
	importId: z.string().uuid(),
	resolutions: resolutionsSchema.optional(),
});
/**
 * A step that reads one stored import (the speech-request step, the mentor step)
 * names the club and the import, nothing else.
 */
export const storedImportSchema = importClubSchema.extend({
	importId: z.string().uuid(),
});
/** An apply names the preview it confirms: see {@link planFingerprint}. */
export const importApplySchema = importRunSchema.extend({
	planHash: z.string().length(64, "Preview again before applying."),
});
