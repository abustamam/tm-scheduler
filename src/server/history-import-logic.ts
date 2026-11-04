/**
 * Easy-Speak import: store a bundle, preview it, apply it, and keep the
 * reconciliation report (#1051, part of #1054).
 *
 * The planning rules are pure and live in `#/lib/easy-speak-import-plan`; this
 * module reads what the club holds, hands it to the planner, and writes what the
 * plan says. It has NO session of its own: `history-import.ts` runs the
 * history-import gate (`requireHistoryImportRunner`) before it calls anything here, and the MCP tool authorises a
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
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	not,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	clubImports,
	clubs,
	guests,
	importRefs,
	meetingAttendance,
	meetingAwards,
	meetings,
	meetingTemplates,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	speechRequests,
	tableTopicsSpeakers,
} from "#/db/schema";
import { generatesSlots } from "#/lib/agenda";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	bundleRange,
	type EasySpeakBundle,
	easySpeakStoredSchema,
	easySpeakUploadSchema,
} from "#/lib/easy-speak-bundle";
import {
	ARCHIVE_FORMAT,
	ARCHIVE_UPLOADED_MESSAGE,
	BUNDLE_FORMAT,
	CURRENT_BUNDLE_VERSION,
	wrongVersionMessage,
} from "#/lib/easy-speak-bundle-version";
import {
	BINDING_REFUSAL_PREFIX,
	buildImportPlan,
	buildReconciliation,
	type ContactFill,
	DELETED_SINCE_IMPORT,
	type FoundSourceIds,
	type ImportPlan,
	type ImportReport,
	isJsonbSafeText,
	leftAloneReason,
	MAX_UNAPPLIED_IMPORTS,
	MEETING_LEFT_ALONE,
	needsDecision,
	type Omission,
	type PersonResolution,
	type PlanContext,
	type PlanCounts,
	type PlanMeeting,
	type PlanPerson,
	type PlanRosterMember,
	type PlanTargetSlot,
	personKeyOf,
	resolutionsSchema,
	scrubJsonbText,
	UPCOMING_ALREADY_HOLDS,
	UPCOMING_KEPT_HOLDER,
	UPCOMING_ROLES_SKIPPED,
	type UpcomingPlan,
} from "#/lib/easy-speak-import-plan";
import {
	bundleTooBigMessage,
	MAX_BUNDLE_BYTES,
} from "#/lib/import-bundle-limit";
import { type ImportRefKind, importRefKindSchema } from "#/lib/import-refs";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { localDateKey } from "#/lib/meeting-url";
import { monthLabel } from "#/lib/month-label";
import { toStoredPhone } from "#/lib/phone";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { isValidEmail, parseRosterText } from "#/lib/roster-import";
import {
	clipImportedText,
	normalizePreferredDates,
} from "#/lib/speech-requests";
import {
	identityIgnoredGuestPerson,
	normalizedEmail,
	normalizeEmail,
	soleHoldingClub,
} from "./account-link-logic";
import { logActivity } from "./activity";
import { importPlanAnswers } from "./attendance-plan-logic";
import { lockClubForWrite } from "./club-write-lock";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { closeCoverRequest } from "./cover-close";
import { assertStillClubAdmin, type HistoryImportRunner } from "./guards";
import { createGuestRecord } from "./guests-logic";
import { insertMeetingWithSlots } from "./meeting-create-logic";
import { loadMeetingShapeDefs } from "./meeting-templates-logic";
import { insertRosterMember } from "./members-logic";
import { openOfficerTermIfAbsent } from "./officer-terms-logic";

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
// Club binding (#1492)
// ---------------------------------------------------------------------------

/** The `logActivity` actor columns for a write the import makes on `runner`'s behalf. */
export function runnerAttribution(runner: HistoryImportRunner): {
	actorMemberId: string | null;
	impersonatedBy: string | null;
} {
	return runner.kind === "admin"
		? {
				actorMemberId: runner.actorMemberId,
				impersonatedBy: runner.impersonatedBy,
			}
		: { actorMemberId: null, impersonatedBy: runner.userId };
}

/** The Easy-Speak club a GavelUp club was first imported from. */
export interface BoundEasySpeakClub {
	esClubId: string;
	name: string;
	number: string | null;
}

const boundClubSchema = z.object({
	esClubId: z.string(),
	name: z.string(),
	number: z.string().nullable().optional(),
});

/**
 * The Easy-Speak club of the club's EARLIEST applied import, or null while none
 * has been applied. Read from the stored rows: there is no binding column.
 */
export async function boundEasySpeakClub(
	conn: Pick<typeof db, "select">,
	clubId: string,
): Promise<BoundEasySpeakClub | null> {
	const [row] = await conn
		.select({ club: sql<unknown>`${clubImports.bundle}->'club'` })
		.from(clubImports)
		.where(
			and(eq(clubImports.clubId, clubId), isNotNull(clubImports.appliedAt)),
		)
		.orderBy(
			sql`coalesce((${clubImports.bundle}->>'firstAppliedAt')::timestamptz, ${clubImports.appliedAt})`,
			asc(clubImports.createdAt),
		)
		.limit(1);
	const parsed = boundClubSchema.safeParse(row?.club);
	if (!parsed.success) return null;
	return {
		esClubId: parsed.data.esClubId,
		name: parsed.data.name,
		number: parsed.data.number ?? null,
	};
}

/** "0012345" and "12345" are the same club number. */
const normalizeClubNumber = (n: string) => n.trim().replace(/^0+/u, "");

/**
 * Why a bundle may not be imported into this club, or null. With a bound
 * Easy-Speak club, only that club's bundles; before the first import, a club
 * number on both sides must agree.
 */
export function bundleClubMismatch(
	bundleClub: BoundEasySpeakClub,
	clubNumber: string | null,
	bound: BoundEasySpeakClub | null,
): string | null {
	if (bound) {
		return bundleClub.esClubId !== bound.esClubId
			? `${BINDING_REFUSAL_PREFIX}${bundleClub.name}, not ${bound.name}, the Easy-Speak club this club was imported from.`
			: null;
	}
	if (
		bundleClub.number &&
		clubNumber &&
		normalizeClubNumber(bundleClub.number) !== normalizeClubNumber(clubNumber)
	) {
		return `${BINDING_REFUSAL_PREFIX}Easy-Speak club ${bundleClub.name} (#${bundleClub.number}), but this club's number is ${clubNumber}.`;
	}
	return null;
}

/** Throws {@link bundleClubMismatch}'s sentence unless `override` (a superadmin's). Returns whether it overrode one. */
export function assertBundleMatchesClub(
	bundleClub: BoundEasySpeakClub,
	clubNumber: string | null,
	bound: BoundEasySpeakClub | null,
	override: boolean | undefined,
): { overrode: boolean } {
	const mismatch = bundleClubMismatch(bundleClub, clubNumber, bound);
	if (mismatch === null) return { overrode: false };
	if (override === true) return { overrode: true };
	throw new BundleRefusal(mismatch);
}

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

export { MAX_UNAPPLIED_IMPORTS };

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
 * `club_imports`. The same hash for the same club is the same row. A club holds
 * at most `MAX_UNAPPLIED_IMPORTS` unapplied rows: storing another deletes the oldest.
 *
 * The raw TEXT is what is hashed, and the parsed JSON (not zod's output, which
 * drops keys the schema does not know) is what is stored, so the row keeps the
 * bundle exactly as it was exported.
 */
export async function storeEasySpeakBundle(input: {
	clubId: string;
	uploadedByUserId: string;
	text: string;
	/** A superadmin's override of the club binding; the server fn passes it only for one. */
	overrideClubBinding?: boolean;
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
	// The envelope first: a stale, newer or archive file gets a sentence about
	// what to do, not whichever zod issue happens to come first.
	if (typeof parsed === "object" && parsed !== null) {
		const envelope = parsed as { format?: unknown; version?: unknown };
		if (envelope.format === ARCHIVE_FORMAT) {
			throw new BundleRefusal(ARCHIVE_UPLOADED_MESSAGE);
		}
		if (
			envelope.format === BUNDLE_FORMAT &&
			envelope.version !== CURRENT_BUNDLE_VERSION
		) {
			throw new BundleRefusal(
				wrongVersionMessage(
					Number.isInteger(envelope.version)
						? (envelope.version as number)
						: null,
				),
			);
		}
	}
	const check = easySpeakUploadSchema.safeParse(parsed);
	if (!check.success) {
		const issue = check.error.issues[0];
		const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
		throw new BundleRefusal(
			`That is not an Easy-Speak bundle: ${issue?.message ?? "invalid"}${where}.`,
		);
	}
	const bundleSha256 = createHash("sha256").update(input.text).digest("hex");

	const [club] = await db
		.select({ archivedAt: clubs.archivedAt, clubNumber: clubs.clubNumber })
		.from(clubs)
		.where(eq(clubs.id, input.clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");
	if (isClubArchived(club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
	// Refused before a row is stored: a bundle from another Easy-Speak club never lands.
	assertBundleMatchesClub(
		check.data.club,
		club.clubNumber,
		await boundEasySpeakClub(db, input.clubId),
		input.overrideClubBinding,
	);

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
	// The count, the delete and the insert are one transaction under the club
	// write lock, so two concurrent uploads cannot both see room and exceed the cap.
	const inserted = await db.transaction(async (tx) => {
		await lockClubForWrite(tx, input.clubId);
		const [row] = await tx
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
		if (!row) return null;
		// A running apply holds the import lock and its final update targets its
		// own row: trimming then could delete that row. Skip the trim; the next
		// upload trims.
		if (await tryTakeImportLock(tx, input.clubId)) {
			// Keep the newest MAX_UNAPPLIED_IMPORTS unapplied rows (by created_at, then
			// id); applied rows are neither counted nor deleted.
			const keep = tx
				.select({ id: clubImports.id })
				.from(clubImports)
				.where(
					and(
						eq(clubImports.clubId, input.clubId),
						isNull(clubImports.appliedAt),
					),
				)
				.orderBy(desc(clubImports.createdAt), desc(clubImports.id))
				.limit(MAX_UNAPPLIED_IMPORTS);
			await tx
				.delete(clubImports)
				.where(
					and(
						eq(clubImports.clubId, input.clubId),
						isNull(clubImports.appliedAt),
						notInArray(clubImports.id, keep),
					),
				);
		}
		return row;
	});
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
	bundle: EasySpeakBundle;
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
	const bundle = easySpeakStoredSchema.parse(row.bundle);
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

/** The upcoming-meetings answer a run carries, with the server's default for the box (#1495). */
export interface UpcomingChoice {
	include: boolean;
	skipRoles: ReadonlySet<string>;
	/** Ticked by default only for a club with no applied import. */
	defaultIncluded: boolean;
}

/**
 * The box's default: no import of this club has ever been applied. Read from the
 * database, so a first import is "ticked" and a later one is not.
 */
async function resolveUpcomingChoice(
	clubId: string,
	given: { include: boolean; skipRoles: string[] } | undefined,
): Promise<UpcomingChoice> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(clubImports)
		.where(
			and(eq(clubImports.clubId, clubId), isNotNull(clubImports.appliedAt)),
		);
	const defaultIncluded = (row?.n ?? 0) === 0;
	return {
		include: given?.include ?? defaultIncluded,
		skipRoles: new Set(given?.skipRoles ?? []),
		defaultIncluded,
	};
}

/**
 * The slots a NEW upcoming meeting gets: the club default agenda's shape, else
 * the standing enabled bank (`startMeetingOnClubDefault`'s three conditions on
 * the template: enabled, the club's own, and not a meeting's copy). A pure read.
 */
async function loadNewMeetingShape(clubId: string) {
	const [club] = await db
		.select({ defaultTemplateId: clubs.defaultTemplateId })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	let templateId: string | null = null;
	if (club?.defaultTemplateId) {
		const [usable] = await db
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(
					eq(meetingTemplates.id, club.defaultTemplateId),
					eq(meetingTemplates.clubId, clubId),
					isNull(meetingTemplates.meetingId),
					eq(meetingTemplates.enabled, true),
				),
			)
			.limit(1);
		templateId = usable?.id ?? null;
	}
	const defs = (
		await loadMeetingShapeDefs(db, clubId, templateId, { onlyEnabled: true })
	).filter(generatesSlots);
	const byId = new Map<string, number>();
	for (const d of defs) {
		byId.set(d.id, (byId.get(d.id) ?? 0) + d.defaultCount);
	}
	return [...byId].map(([roleDefinitionId, count]) => ({
		roleDefinitionId,
		count,
	}));
}

/** The slots of every `scheduled` meeting still ahead, by meeting id. */
async function loadUpcomingSlots(clubId: string, now: Date) {
	const rows = await db
		.select({
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(meetings.clubId, clubId),
				eq(meetings.status, "scheduled"),
				gt(meetings.scheduledAt, now),
			),
		);
	const out = new Map<string, PlanTargetSlot[]>();
	for (const r of rows) {
		const list = out.get(r.meetingId) ?? [];
		list.push({
			roleDefinitionId: r.roleDefinitionId,
			slotIndex: r.slotIndex,
			holder: r.memberId
				? { memberId: r.memberId }
				: r.guestId
					? { guestId: r.guestId }
					: null,
		});
		out.set(r.meetingId, list);
	}
	return out;
}

async function loadPlanContext(
	clubId: string,
	now: Date,
	resolutions: Record<string, PersonResolution>,
	contacts: string | undefined,
	upcoming: UpcomingChoice,
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

	// A `person` ref that names no row, for a member the club REMOVED: the removal
	// logs `member_remove` against the member id (`applyMemberRemove`), which
	// survives the delete. A merge carries the refs to the keeper
	// (`collapseMemberships`, #1494), so only a merge from before that leaves one
	// dangling: that member is matched by name again (D4 of #1196). A null `member_add` actor is
	// NOT used: impersonated adds, bulk imports and a removed actor all have one.
	const refMemberIds = refs
		.filter((r) => r.kind === "person")
		.map((r) => r.targetId);
	const removedRows =
		refMemberIds.length === 0
			? []
			: await db
					.select({ targetId: activityLog.targetId })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, clubId),
							eq(activityLog.action, "member_remove"),
							eq(activityLog.targetType, "member"),
							inArray(activityLog.targetId, refMemberIds),
							// A convert undo that KEPT the membership removed no one.
							sql`${activityLog.detail}->>'membershipDeleted' is distinct from 'false'`,
						),
					);
	return {
		ctx: {
			now,
			clubTimezone: club.timezone,
			removedMemberIds: new Set(
				removedRows.flatMap((r) => (r.targetId ? [r.targetId] : [])),
			),
			contacts,
			contactState: await loadContactState(clubId, contacts),
			roster: roster.map((m) => ({ memberId: m.memberId, name: m.name })),
			roleDefinitions: defs,
			guestIds: new Set(guestRows.map((g) => g.id)),
			existingMeetings: meetingRows,
			refs,
			resolutions,
			importUpcoming: upcoming.include,
			skipUpcomingRoles: upcoming.skipRoles,
			newMeetingShape: await loadNewMeetingShape(clubId),
			upcomingSlots: await loadUpcomingSlots(clubId, now),
		},
		personByMember: new Map(roster.map((m) => [m.memberId, m.personId])),
		club,
	};
}

/**
 * What the plan needs to place pasted contacts (#1240): what each roster member
 * already holds, and who holds each pasted email. Read only when there are
 * contacts, and only for the emails pasted.
 */
async function loadContactState(
	clubId: string,
	contacts: string | undefined,
): Promise<PlanContext["contactState"]> {
	if (!contacts || contacts.trim() === "") return undefined;
	const emails = [
		...new Set(
			parseRosterText(contacts)
				.map((r) => normalizeEmail(r.email) ?? "")
				.filter((e) => e !== "" && isValidEmail(e)),
		),
	];
	const memberRows = await db
		.select({
			memberId: members.id,
			personId: members.personId,
			email: people.email,
			phone: people.phone,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.clubId, clubId));
	// The member-edit rule for a linked member's email (#907), asked with the same
	// predicates the apply's UPDATE carries, so the plan never promises a fill the
	// apply will skip. Read in its own query on `people`, the shape `soleHoldingClub` is written for.
	const writable = new Set<string>();
	const personIds = [...new Set(memberRows.map((m) => m.personId))];
	for (let i = 0; i < personIds.length; i += 1000) {
		const rows = await db
			.select({ id: people.id })
			.from(people)
			.where(
				and(
					inArray(people.id, personIds.slice(i, i + 1000)),
					isNull(people.userId),
					soleHoldingClub(clubId),
				),
			);
		for (const r of rows) writable.add(r.id);
	}
	const holders = new Map<string, Set<string>>();
	for (let i = 0; i < emails.length; i += 1000) {
		// Held by a member of THIS club only (#1492): who holds an address in another
		// club is not something a club admin's preview may learn.
		const rows = await db
			.select({ id: people.id, email: people.email })
			.from(people)
			.innerJoin(
				members,
				and(eq(members.personId, people.id), eq(members.clubId, clubId)),
			)
			.where(
				and(
					inArray(normalizedEmail(people.email), emails.slice(i, i + 1000)),
					not(identityIgnoredGuestPerson()),
				),
			);
		for (const r of rows) {
			const key = normalizeEmail(r.email) ?? "";
			holders.set(key, (holders.get(key) ?? new Set()).add(r.id));
		}
	}
	return {
		members: new Map(
			memberRows.map((m) => [
				m.memberId,
				{
					personId: m.personId,
					email: m.email,
					phone: m.phone,
					emailWritable: writable.has(m.personId),
				},
			]),
		),
		emailHolders: holders,
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
	/** The first import's Easy-Speak club → this club; null once a club is bound (#1492). */
	binding: {
		esName: string;
		esNumber: string | null;
		clubName: string;
	} | null;
	warnings: string[];
	/** The months the bundle's meeting list covers (#1491); null for a full-history bundle, and for v1/v2. */
	range: { fromMonth: string } | null;
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
	/** What the upcoming meetings would do and whether the box is ticked (#1495). */
	upcoming: UpcomingPlan;
	roster: PlanRosterMember[];
	unresolvedCount: number;
	/** What the pasted contacts would set, as counts, and the rows that set nothing (row numbers and names, never a value). */
	contacts: { emails: number; phones: number; warnings: string[] };
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
 * in between). The pasted contacts text is part of it (#1240): the same bundle
 * with other contacts is another apply, and so is who each row lands on.
 */
export function planFingerprint(plan: ImportPlan, contacts = ""): string {
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
		// #1495: the box, the Skip answers and where each upcoming holder lands. A
		// changed box, a changed answer or a slot filled in between moves the plan.
		upcoming: plan.upcoming
			? {
					included: plan.upcoming.included,
					skipRoles: plan.upcoming.skipRoles,
					targets: plan.meetings
						.filter((m) => m.upcoming)
						.map((m) => [
							m.esMeetingId,
							m.slots.map((sl) => [
								sl.esSlot,
								sl.slotIndex,
								sl.addSlot ?? false,
								sl.kept ?? null,
							]),
						]),
				}
			: null,
		contacts,
		// Which pasted row lands on whom and which fields it sets, never the values: a
		// rename or a released email moves a row to another person under the same
		// text, and two renames can swap two rows' recipients while each key still
		// sets the same fields, so the row number is part of each entry. (The member a key resolves to is already in `people` above.)
		contactFills: plan.contactFills
			.map((f) => [f.row, f.personKey, f.email !== null, f.phone !== null])
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The month (`yyyy-mm`, club-local) the club's next Easy-Speak export should start from
 * (#1491): the newest imported meeting that had started by the newest applied import's
 * `exportedAt` (the export also lists upcoming meetings, whose month would skip the ones held
 * since). Null when the club has no applied import or no such meeting. A meeting row deleted
 * since the import drops out of the join; that is accepted.
 */
export async function nextExportMonth(clubId: string): Promise<string | null> {
	const [cutoffRow] = await db
		.select({
			at: sql<
				string | Date | null
			>`max((${clubImports.bundle}->>'exportedAt')::timestamptz)`,
		})
		.from(clubImports)
		.where(
			and(eq(clubImports.clubId, clubId), isNotNull(clubImports.appliedAt)),
		);
	if (!cutoffRow?.at) return null;
	const cutoff = new Date(cutoffRow.at);
	const [newest] = await db
		.select({ at: sql<string | Date | null>`max(${meetings.scheduledAt})` })
		.from(importRefs)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, importRefs.targetId),
				eq(meetings.clubId, importRefs.clubId),
			),
		)
		.where(
			and(
				eq(importRefs.clubId, clubId),
				eq(importRefs.source, SOURCE),
				eq(importRefs.kind, "meeting"),
				lte(meetings.scheduledAt, cutoff),
			),
		);
	if (!newest?.at) return null;
	const [club] = await db
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) return null;
	return localDateKey(new Date(newest.at), club.timezone).slice(0, 7);
}

/** The preview a superadmin confirms: the plan, summarised, plus any stored report. */
export async function previewEasySpeakImport(input: {
	clubId: string;
	importId: string;
	resolutions?: Record<string, PersonResolution>;
	/** Pasted `name, email, phone` rows; read, never stored. */
	contacts?: string;
	/** The upcoming-meetings box and the roles answered "Skip" (#1495); never stored. */
	upcoming?: { include: boolean; skipRoles: string[] };
	now?: Date;
}): Promise<ImportPreview> {
	const stored = await loadStoredBundle(input.clubId, input.importId);
	const resolutions = resolutionsSchema.parse({
		...stored.state.resolutions,
		...input.resolutions,
	});
	const choice = await resolveUpcomingChoice(input.clubId, input.upcoming);
	const loaded = await loadPlanContext(
		input.clubId,
		input.now ?? new Date(),
		resolutions,
		input.contacts,
		choice,
	);
	const plan = buildImportPlan(stored.bundle, loaded.ctx);
	plan.upcoming.defaultIncluded = choice.defaultIncluded;
	const warnings: string[] = [];
	const { club } = stored.bundle;
	const bound = await boundEasySpeakClub(db, input.clubId);
	// The apply refuses this; the preview of an already stored bundle says why.
	const mismatch = bundleClubMismatch(club, loaded.club.clubNumber, bound);
	if (mismatch) warnings.push(mismatch);
	if (isClubArchived(loaded.club)) warnings.push(CLUB_ARCHIVED_MESSAGE);
	const range = bundleRange(stored.bundle);
	// A bounded bundle that starts after the club's imported history ends leaves a gap:
	// warn, never block (it does not touch `canApply`).
	if (range && stored.appliedAt === null) {
		const next = await nextExportMonth(input.clubId);
		if (next !== null && range.fromMonth > next) {
			warnings.push(
				`This bundle starts ${monthLabel(range.fromMonth)}; GavelUp's imported history ends ${monthLabel(next)}. Meetings in between will not be imported. Export from ${monthLabel(next)} to close the gap.`,
			);
		}
	}
	warnings.push(...plan.notes);
	return {
		importId: input.importId,
		planHash: planFingerprint(plan, input.contacts),
		appliedAt: stored.appliedAt?.toISOString() ?? null,
		bundleClub: { name: club.name, number: club.number },
		club: { name: loaded.club.name, number: loaded.club.clubNumber },
		binding: bound
			? null
			: {
					esName: club.name,
					esNumber: club.number,
					clubName: loaded.club.name,
				},
		warnings,
		range,
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
		upcoming: plan.upcoming,
		roster: loaded.ctx.roster,
		unresolvedCount: plan.unresolved.length,
		contacts: {
			emails: plan.contactFills.filter((f) => f.email).length,
			phones: plan.contactFills.filter((f) => f.phone).length,
			warnings: plan.contactWarnings,
		},
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
	/** Members this apply made (#1240), and the Person of each. */
	newMembers: { active: number; former: number; officers: number };
	personByNewMember: Map<string, string>;
	/** Contact values left blank at write time, by row and person: never a value. */
	contactNotes: string[];
}

/** What the member-making part of the apply needs beyond the plan (#1240). */
export interface WritePeopleOptions {
	/** Who each `member_add` is attributed to. */
	runner?: HistoryImportRunner | null;
	/** The answers saved by the earlier apply: a replay of one is not a change. */
	previousResolutions?: Record<string, PersonResolution>;
	now?: Date;
	/** The club's zone, for the day an officer term opens. */
	timezone?: string | null;
	/** The club's default country code, for a pasted phone. */
	countryCode?: string | null;
}

/** The actor columns for a write with or without a known runner (a direct caller). */
const attribution = (runner: HistoryImportRunner | null | undefined) =>
	runner
		? runnerAttribution(runner)
		: { actorMemberId: null, impersonatedBy: null };

/** One neutral sentence for every skip: it names no club, no person and no account. */
const emailTakenNote = (row: number, name: string) =>
	`The email in row ${row} was left blank for ${name}: that address is already in use in GavelUp.`;

/** Another Person (any club) already holds this email, case-insensitively. */
async function emailHeldByOther(
	tx: Tx,
	email: string,
	exceptPersonId: string | null,
): Promise<boolean> {
	const rows = await tx
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				eq(normalizedEmail(people.email), normalizeEmail(email) ?? ""),
				not(identityIgnoredGuestPerson()),
			),
		);
	return rows.some((r) => r.id !== exceptPersonId);
}

/**
 * Fill a LINKED member's blank email and phone from a contact row. Both updates
 * carry the blank test in their own WHERE, so a value someone set since the
 * preview is never overwritten, and a re-apply re-runs them harmlessly.
 */
async function fillMemberContact(
	tx: Tx,
	clubId: string,
	memberId: string,
	fill: ContactFill,
	opts: WritePeopleOptions,
	out: Resolved,
): Promise<void> {
	const [row] = await tx
		.select({ personId: members.personId })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)))
		.limit(1);
	if (!row) return;
	if (fill.email) {
		if (await emailHeldByOther(tx, fill.email, row.personId)) {
			out.contactNotes.push(emailTakenNote(fill.row, fill.name));
		} else {
			const filled = await tx
				.update(people)
				.set({ email: fill.email })
				.where(
					and(
						eq(people.id, row.personId),
						isNull(people.userId),
						soleHoldingClub(clubId),
						or(isNull(people.email), eq(people.email, "")),
					),
				)
				.returning({ id: people.id });
			if (filled.length === 0) {
				const [current] = await tx
					.select({ email: people.email })
					.from(people)
					.where(eq(people.id, row.personId))
					.limit(1);
				if (current && !current.email) {
					out.contactNotes.push(
						`The email in row ${fill.row} was left blank for ${fill.name}: the person has a GavelUp account or belongs to another club, so it is theirs to add.`,
					);
				}
			}
		}
	}
	const phone = toStoredPhone(fill.phone, opts.countryCode);
	if (phone) {
		await tx
			.update(people)
			.set({ phone })
			.where(
				and(
					eq(people.id, row.personId),
					or(isNull(people.phone), eq(people.phone, "")),
				),
			);
	}
}

/** People, then role definitions: everything every meeting needs, written once. */
export async function writePeopleAndRoles(
	clubId: string,
	plan: ImportPlan,
	opts: WritePeopleOptions = {},
): Promise<Resolved> {
	return db.transaction(async (tx) => {
		await lockClubForWrite(tx, clubId);
		if (opts.runner) await assertRunnerStillAllowed(tx, opts.runner, clubId);
		await assertClubNotArchivedTx(tx, clubId);
		const out: Resolved = {
			members: new Map(),
			guests: new Map(),
			deleted: new Set(),
			roleDefIds: new Map(),
			newGuests: 0,
			newRoleDefinitions: [],
			newMembers: { active: 0, former: 0, officers: 0 },
			personByNewMember: new Map(),
			contactNotes: [],
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
		const fillByKey = new Map<string, ContactFill>(
			plan.contactFills.map((f) => [f.personKey, f]),
		);

		// Members first (#1240): everyone who has no member here and is on the member
		// list or in a meeting. A retried apply never gets here for the same person:
		// the plan resolved them through their `person` ref and they are `member`.
		const timezone = opts.timezone ?? "UTC";
		const day = localDateKey(opts.now ?? new Date(), timezone);
		const termStart = zonedWallTimeToUtc(`${day}T00:00`, timezone);
		for (const person of plan.people) {
			const o = person.outcome;
			if (o.status !== "create") continue;
			const fill = fillByKey.get(person.key);
			let email = fill?.email ?? null;
			if (fill && email && (await emailHeldByOther(tx, email, null))) {
				out.contactNotes.push(emailTakenNote(fill.row, person.name));
				email = null;
			}
			const joined = o.joinedAt ? new Date(`${o.joinedAt}T12:00:00Z`) : null;
			const created = await insertRosterMember(tx, {
				clubId,
				name: person.name.trim(),
				email,
				phone: toStoredPhone(fill?.phone, opts.countryCode),
				status: o.membership,
				endedAt: null,
				joinedAt: joined && !Number.isNaN(joined.getTime()) ? joined : null,
				clubRole: o.position ? "admin" : "member",
				orientation: false,
			});
			await logActivity(tx, {
				clubId,
				...attribution(opts.runner),
				action: "member_add",
				targetType: "member",
				targetId: created.id,
				detail: { name: person.name.trim() },
			});
			if (o.position) {
				await openOfficerTermIfAbsent(tx, created.id, o.position, termStart);
				out.newMembers.officers++;
			}
			if (o.membership === "active") out.newMembers.active++;
			else out.newMembers.former++;
			out.members.set(person.key, created.id);
			out.personByNewMember.set(created.id, created.personId);
			await putRef(tx, clubId, "person", person.key, created.id);
			for (const alias of o.mergedKeys ?? []) {
				// Stored now: a rename before the next apply must not send the alias
				// back through a name match (a duplicate, or a later namesake).
				out.members.set(alias, created.id);
				await putRef(tx, clubId, "person", alias, created.id);
			}
		}

		for (const person of plan.people) {
			const o = person.outcome;
			if (o.status === "member") {
				out.members.set(person.key, o.memberId);
				await putRef(tx, clubId, "person", person.key, o.memberId);
				const fill = fillByKey.get(person.key);
				if (fill) {
					await fillMemberContact(tx, clubId, o.memberId, fill, opts, out);
				}
			} else if (o.status === "deleted") {
				out.deleted.add(person.key);
			} else if (o.status === "guest") {
				if (o.guestId) {
					// The saved answer's kind is the stored guest's kind: a changed answer
					// must not leave the preview and the record disagreeing.
					// Only when the answer CHANGED in this import: a replay of the answer
					// already applied must not revert a kind an officer set in the app.
					const prior = opts.previousResolutions?.[person.key];
					const replay = prior?.action === "guest" && prior.kind === o.kind;
					if (o.via === "chosen" && !replay) {
						await tx
							.update(guests)
							.set({ kind: o.kind })
							.where(and(eq(guests.id, o.guestId), eq(guests.clubId, clubId)));
					}
					out.guests.set(person.key, o.guestId);
					continue;
				}
				// The plan never makes a guest of a person no meeting names (#1203);
				// this is the second lock on that door.
				if (person.listOnly) continue;
				let introducedByMemberId: string | null = null;
				const introducerKey = introducerOf.get(person.key) ?? "";
				const introducer = byKey.get(introducerKey);
				// The loop is name-sorted, so a creating introducer who sorts after the
				// guest is not in `out.members` yet; a linked one always has its id.
				// A merged alias is in `out.members` but not in `plan.people`.
				const introducerMemberId =
					out.members.get(introducerKey) ??
					(introducer?.outcome.status === "member"
						? introducer.outcome.memberId
						: undefined);
				if (introducerMemberId) {
					introducedByMemberId = await validatedIntroducerId(
						tx,
						clubId,
						introducerMemberId,
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
	/** The club's own zone: an upcoming meeting is matched by its local date (#1495). */
	timezone: string;
	/** The club's role bank, for a created upcoming meeting's slots (#1495). */
	bankDefs: Array<typeof roleDefinitions.$inferSelect>;
	/** Who runs the apply; asked again under the lock in every meeting's transaction. */
	runner: HistoryImportRunner;
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
		await assertRunnerStillAllowed(tx, env.runner, clubId);
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
					// An open cover request on a slot the import just filled is covered
					// by its holder (#1438).
					if (owner) await closeCoverRequest(tx, updated.id, owner);
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

/**
 * One UPCOMING meeting (#1495), in its own transaction. A different writer from
 * {@link applyMeeting}: it writes into a meeting that is still `scheduled`, so it
 * refuses by the PLAN class (a cancelled or completed meeting is left alone), not
 * the record class a history import's past meeting is written through.
 *
 * - **Never displaces.** Only a slot that is still empty receives a holder, with
 *   the `isNull` guard on the write; a holder who finds the slot taken is reported
 *   as "Kept GavelUp's holder". Set values and the time are never changed: a blank
 *   theme, Word of the Day, join link or location is filled, nothing else.
 * - **Matched by club-local date under the lock.** The plan was read before the
 *   lock, so a `create` re-reads the day: a `scheduled` meeting that appeared is
 *   adopted, any other status is left alone.
 * - **Notifies no one.** Nothing here sends mail or logs a lineup; a filled slot
 *   closes an open cover request, as every fill does.
 */
async function applyUpcomingMeeting(
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
	const omitHolder = (
		ps: PlanMeeting["slots"][number],
		cause: { what: string; reason: string },
	) => {
		omit("roleAssignment", ps.sourceId, cause);
		if (ps.speech) omit("speech", ps.speech.sourceId, cause);
	};
	let applied = true;
	await db.transaction(async (tx) => {
		await lockClubForWrite(tx, clubId);
		await assertRunnerStillAllowed(tx, env.runner, clubId);
		await assertClubNotArchivedTx(tx, clubId);

		// -- The meeting row --------------------------------------------------
		const acceptable = (x: typeof meetings.$inferSelect) =>
			x.status === "scheduled" && x.scheduledAt.getTime() > env.now.getTime();
		const dateOf = (d: Date) =>
			utcToZonedWallTime(d, env.timezone).slice(0, 10);
		const joinUrl = normalizePresentationUrl(pm.joinUrl);
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
			// Re-read the DAY under the lock (not the instant): the plan matched by
			// club-local date, and a meeting may have been made there since.
			const day = pm.scheduledAt.getTime();
			const near = await tx
				.select()
				.from(meetings)
				.where(
					and(
						eq(meetings.clubId, clubId),
						gte(meetings.scheduledAt, new Date(day - 36 * 3_600_000)),
						lte(meetings.scheduledAt, new Date(day + 36 * 3_600_000)),
					),
				)
				.orderBy(meetings.createdAt, meetings.id)
				.for("no key update");
			const onDate = near.filter(
				(x) => dateOf(x.scheduledAt) === dateOf(pm.scheduledAt),
			);
			m = onDate.find(acceptable) ?? onDate[0];
		}
		if (m && !acceptable(m)) {
			omit("meeting", pm.esMeetingId, {
				what: MEETING_LEFT_ALONE,
				reason: leftAloneReason(m.status),
			});
			applied = false;
			return;
		}
		if (!m) {
			const [club] = await tx
				.select({ defaultLocation: clubs.defaultLocation })
				.from(clubs)
				.where(eq(clubs.id, clubId))
				.limit(1);
			const createdId = await insertMeetingWithSlots(
				tx,
				{
					clubId,
					scheduledAt: pm.scheduledAt,
					lengthMinutes: env.lengthMinutes,
					location: pm.venue ?? club?.defaultLocation ?? null,
					meta: {
						theme: pm.theme,
						wordOfTheDay: pm.wordOfTheDay,
						wodDefinition: null,
						wodExample: null,
					},
				},
				env.bankDefs,
			);
			const [row] = await tx
				.select()
				.from(meetings)
				.where(
					createdId
						? eq(meetings.id, createdId)
						: and(
								eq(meetings.clubId, clubId),
								eq(meetings.scheduledAt, pm.scheduledAt),
							),
				)
				.limit(1)
				.for("no key update");
			// A meeting appeared at this very instant since the read above: adopt it
			// if it is a scheduled one, or leave it alone.
			if (!row) throw new Error("Could not create the meeting.");
			if (!createdId && !acceptable(row)) {
				omit("meeting", pm.esMeetingId, {
					what: MEETING_LEFT_ALONE,
					reason: leftAloneReason(row.status),
				});
				applied = false;
				return;
			}
			m = row;
		}
		// Refuses a cancelled or completed meeting, by the plan class.
		assertMeetingAccepts(m.status, "plan");
		const meetingId = m.id;
		// Fill a blank, nothing else: the status and the time are not ours to change.
		await tx
			.update(meetings)
			.set({
				location: m.location ?? pm.venue,
				joinUrl: m.joinUrl ?? joinUrl,
				theme: m.theme ?? pm.theme,
				wordOfTheDay: m.wordOfTheDay ?? pm.wordOfTheDay,
			})
			.where(eq(meetings.id, m.id));
		await putRef(tx, clubId, "meeting", pm.esMeetingId, meetingId);

		// -- Refs this meeting already has ------------------------------------
		const sourceIds = [
			...pm.slots.map((sl) => sl.sourceId),
			...pm.slots.flatMap((sl) => (sl.speech ? [sl.speech.sourceId] : [])),
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
		const keptSpeeches = await stillThere(
			tx,
			speeches.id,
			refRows.filter((r) => r.kind === "speech").map((r) => r.targetId),
		);

		// -- Role slots: the empty ones only ------------------------------------
		const existingSlots = await tx
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, meetingId));
		const slotIdByEsSlot = new Map<number, string>();
		for (const ps of pm.slots) {
			if (ps.kept === "skipped") {
				omitHolder(ps, UPCOMING_ROLES_SKIPPED);
				continue;
			}
			if (ps.kept === "already") {
				omitHolder(ps, UPCOMING_ALREADY_HOLDS);
				continue;
			}
			if (ps.kept === "taken") {
				omitHolder(ps, UPCOMING_KEPT_HOLDER);
				continue;
			}
			const roleDefinitionId = env.resolved.roleDefIds.get(ps.roleKey);
			if (!roleDefinitionId)
				throw new Error(`No role definition for ${ps.label}.`);
			if (isTombstoned(env, ps.holderKey)) {
				omitHolder(ps, DELETED_SINCE_IMPORT);
				continue;
			}
			const owner = ownerOf(env, ps.holderKey);
			if (!owner) continue;
			const importedSlot = refOf("role_slot", ps.sourceId);
			if (importedSlot && !existingSlots.some((x) => x.id === importedSlot)) {
				// This role slot was imported and has been deleted since.
				omitHolder(ps, DELETED_SINCE_IMPORT);
				continue;
			}
			const assignment =
				"memberId" in owner
					? { assignedMemberId: owner.memberId, assignedGuestId: null }
					: { assignedMemberId: null, assignedGuestId: owner.guestId };
			let slot = existingSlots.find(
				(x) =>
					x.roleDefinitionId === roleDefinitionId &&
					x.slotIndex === ps.slotIndex,
			);
			if (!slot) {
				// Only a slot the plan said to add, or any slot of a meeting made under
				// the lock whose shape the plan could not see, is inserted.
				if (!ps.addSlot && pm.action !== "create") {
					omitHolder(ps, UPCOMING_KEPT_HOLDER);
					continue;
				}
				const [created] = await tx
					.insert(roleSlots)
					.values({
						meetingId,
						roleDefinitionId,
						slotIndex: ps.slotIndex,
						status: "confirmed",
						...assignment,
					})
					.returning();
				if (!created) throw new Error("Could not create a role slot.");
				slot = created;
			} else if (
				slot.assignedMemberId === null &&
				slot.assignedGuestId === null
			) {
				// Only a slot that is STILL empty: someone who claimed it since the plan
				// keeps it, and the row is read again to say so.
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
					await closeCoverRequest(tx, updated.id, owner);
				} else {
					const [current] = await tx
						.select()
						.from(roleSlots)
						.where(eq(roleSlots.id, slot.id))
						.limit(1);
					slot = current ?? slot;
				}
			}
			if (!sameOwner(owner, slot.assignedMemberId, slot.assignedGuestId)) {
				omitHolder(ps, UPCOMING_KEPT_HOLDER);
				continue;
			}
			slotIdByEsSlot.set(ps.esSlot, slot.id);
			await putRef(tx, clubId, "role_slot", ps.sourceId, slot.id);

			if (ps.speech && !slot.speechId) {
				const speechRef = refOf("speech", ps.speech.sourceId);
				let speechId: string | undefined;
				if (speechRef && !keptSpeeches.has(speechRef)) {
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
		// Evaluator -> the speaker slot it evaluates, once every slot is placed.
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

		// -- RSVPs, only on the first apply of the meeting ------------------------
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
			await importPlanAnswers(
				tx,
				{ meetingId, answers: planAnswers },
				{ allowScheduled: true },
			);
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
			// A past meeting is `completed`; an upcoming one (#1495) stays `scheduled`.
			.where(
				and(
					scope("meeting"),
					inArray(meetings.status, ["completed", "scheduled"]),
				),
			),
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
export async function tryTakeImportLock(
	tx: Tx,
	clubId: string,
): Promise<boolean> {
	const taken = await tx.execute<{ ok: boolean }>(
		sql`select pg_try_advisory_xact_lock(hashtextextended(${`history-import:${clubId}`}, 0)) as ok`,
	);
	return taken.rows[0]?.ok === true;
}

export async function takeImportLock(tx: Tx, clubId: string): Promise<void> {
	if (!(await tryTakeImportLock(tx, clubId))) {
		throw new Error(IMPORT_RUNNING_MESSAGE);
	}
}

/**
 * Apply a stored bundle to its club. The caller has proved who may run it.
 *
 * Refused while any person is unresolved, and for an archived club. Re-running is
 * safe: see the module header. Returns the stored report.
 */
export async function applyEasySpeakImport(input: {
	clubId: string;
	importId: string;
	/** Who runs it; the change is attributed to them. */
	runner: HistoryImportRunner;
	resolutions?: Record<string, PersonResolution>;
	/** The `planHash` of the preview the runner confirmed; a plan that has moved is refused. */
	planHash?: string;
	/** Pasted `name, email, phone` rows (#1240): placed on people, never stored by the import. */
	contacts?: string;
	/** The upcoming-meetings box and Skip answers (#1495); absent means the server default. */
	upcoming?: { include: boolean; skipRoles: string[] };
	/** A superadmin's override of the club binding; the server fn passes it only for one. */
	overrideClubBinding?: boolean;
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
		await assertRunnerStillAllowed(guard, input.runner, input.clubId);
		return applyUnderImportLock(input);
	});
}

/**
 * Re-ask the club-admin question inside the transaction, after the lock (#806):
 * an admin whose term closed, or whose club was archived, while the run queued
 * writes nothing. A superadmin (a read-write impersonation session is one) has no
 * membership to re-ask about and is not re-checked here. Called after
 * `lockClubForWrite` in EVERY transaction that writes, not once per run.
 */
export async function assertRunnerStillAllowed(
	tx: Tx,
	runner: HistoryImportRunner,
	clubId: string,
): Promise<void> {
	if (runner.kind === "admin") {
		await assertStillClubAdmin(tx, runner.userId, clubId);
	}
}

async function applyUnderImportLock(input: {
	clubId: string;
	importId: string;
	runner: HistoryImportRunner;
	resolutions?: Record<string, PersonResolution>;
	planHash?: string;
	contacts?: string;
	upcoming?: { include: boolean; skipRoles: string[] };
	overrideClubBinding?: boolean;
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
	const choice = await resolveUpcomingChoice(input.clubId, input.upcoming);
	const loaded = await loadPlanContext(
		input.clubId,
		now,
		resolutions,
		input.contacts,
		choice,
	);
	if (isClubArchived(loaded.club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
	// A bundle stored before another one was applied is refused here too.
	const binding = assertBundleMatchesClub(
		stored.bundle.club,
		loaded.club.clubNumber,
		await boundEasySpeakClub(db, input.clubId),
		input.overrideClubBinding,
	);
	const plan = buildImportPlan(stored.bundle, loaded.ctx);
	if (!plan.canApply) {
		throw new Error(UNRESOLVED_PEOPLE_MESSAGE(plan.unresolved.length));
	}
	if (
		input.planHash !== undefined &&
		input.planHash !== planFingerprint(plan, input.contacts)
	) {
		throw new Error(PLAN_CHANGED_MESSAGE);
	}

	// The club's bank, read BEFORE the people step can mint a role of its own: a
	// created upcoming meeting is shaped like the plan said it would be (#1495).
	const bankDefs = plan.meetings.some(
		(m) => m.upcoming && m.action === "create",
	)
		? await db
				.select()
				.from(roleDefinitions)
				.where(eq(roleDefinitions.clubId, input.clubId))
				.orderBy(asc(roleDefinitions.sortOrder))
		: [];
	const resolved = await writePeopleAndRoles(input.clubId, plan, {
		runner: input.runner,
		previousResolutions: stored.state.resolutions,
		now,
		timezone: loaded.ctx.clubTimezone,
		countryCode: await loadClubDefaultCountryCode(input.clubId),
	});
	const env: MeetingEnv = {
		clubId: input.clubId,
		now,
		lengthMinutes: loaded.club.defaultMeetingMinutes,
		timezone: loaded.ctx.clubTimezone,
		bankDefs,
		runner: input.runner,
		resolved,
		personByMember: new Map([
			...loaded.personByMember,
			...resolved.personByNewMember,
		]),
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
			const outcome = pm.upcoming
				? await applyUpcomingMeeting(env, pm)
				: await applyMeeting(env, pm);
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
			members: resolved.newMembers,
		},
		omissions,
		includeUpcoming: plan.upcoming.included,
	});
	// Rows that set nothing, or a value left blank: a row number and a person, never
	// the email or the phone, because this report is stored.
	// A person's name can carry a NUL or a lone surrogate, which would fail the
	// jsonb write after the people and meetings have committed.
	const contactNotes = [...plan.contactWarnings, ...resolved.contactNotes].map(
		(n) => scrubJsonbText(n),
	);
	if (contactNotes.length > 0) report.contactNotes = contactNotes;

	const importState = JSON.stringify({ resolutions, report });
	await db.transaction(async (tx) => {
		await lockClubForWrite(tx, input.clubId);
		await assertRunnerStillAllowed(tx, input.runner, input.clubId);
		await tx
			.update(clubImports)
			.set({
				appliedAt: now,
				// The binding reads the FIRST apply (`boundEasySpeakClub`); a re-apply
				// refreshes `applied_at` (the latest report) but never this stamp.
				bundle: sql`${clubImports.bundle} || jsonb_build_object('importState', ${importState}::jsonb, 'firstAppliedAt', coalesce(${clubImports.bundle}->>'firstAppliedAt', ${clubImports.appliedAt}::text, ${now.toISOString()}::text))`,
			})
			.where(
				and(
					eq(clubImports.id, input.importId),
					eq(clubImports.clubId, input.clubId),
				),
			);
		await logActivity(tx, {
			clubId: input.clubId,
			...runnerAttribution(input.runner),
			action: "history_imported",
			targetType: "club",
			targetId: input.clubId,
			detail: {
				importId: input.importId,
				source: SOURCE,
				...(binding.overrode ? { overrodeClubBinding: true } : {}),
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
	request: EasySpeakBundle["speechRequests"][number],
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
 * proved who may run it.
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
	/** Who runs it; the change is attributed to them. */
	runner: HistoryImportRunner;
	now?: Date;
}): Promise<SpeechRequestImportResult> {
	const now = input.now ?? new Date();
	const stored = await loadStoredBundle(input.clubId, input.importId);
	if (!stored.appliedAt) throw new Error(IMPORT_NOT_APPLIED_MESSAGE);
	const requests = stored.bundle.speechRequests;

	return db.transaction(async (tx) => {
		await takeImportLock(tx, input.clubId);
		await lockClubForWrite(tx, input.clubId);
		await assertRunnerStillAllowed(tx, input.runner, input.clubId);
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
			...runnerAttribution(input.runner),
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
	/** A superadmin's override of the club binding; refused from anyone else (#1492). */
	overrideClubBinding: z.boolean().optional(),
	/** The bundle's JSON text, as read from the file. The logic enforces the cap. */
	text: z.string().min(1, "Choose a file to upload."),
});
/** The most pasted contact text a preview or an apply takes (#1240). */
export const MAX_CONTACTS_CHARS = 200_000;
export const importRunSchema = importClubSchema.extend({
	importId: z.string().uuid(),
	resolutions: resolutionsSchema.optional(),
	/** Optional `name, email, phone` rows. Travels with the request; never stored by the import. */
	contacts: z
		.string()
		.max(MAX_CONTACTS_CHARS, "Keep the contacts under 200 KB.")
		.optional(),
	/** #1495: the "Import upcoming meetings" box and the roles answered "Skip". Never stored. */
	upcoming: z
		.object({
			include: z.boolean(),
			skipRoles: z.array(z.string().max(200)).max(200),
		})
		.optional(),
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
	overrideClubBinding: z.boolean().optional(),
	planHash: z.string().length(64, "Preview again before applying."),
});
