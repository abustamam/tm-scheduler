/**
 * Reads and materialization for agenda templates.
 *
 * A `*-logic.ts` module rather than part of `meeting-templates.ts` for the two
 * independent reasons this repo already documents: a top-level db-touching
 * export inside a server-fn module drags `#/db` → `pg` → `Buffer` into the
 * client bundle, and a query living only inside a `createServerFn` handler is
 * unreachable from vitest.
 */
import { and, asc, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { db } from "#/db";
import { db as database } from "#/db";
import {
	clubs,
	guests,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-rows";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	type ClubTemplateFields,
	clubTemplateKeySlug,
	firstFreeClubTemplateKey,
	parseClubTemplateFields,
	retiredTemplateKey,
} from "#/lib/club-template-key";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import {
	distinctRoleDefs,
	matchRoleDefs,
	type RoleIdentity,
} from "#/lib/role-def-match";
import { logActivity } from "./activity";
import { assertClubNotArchived, requireClubRole, requireUser } from "./guards";
import { materialiseAgendaForMeeting } from "./meeting-agenda-edit-logic";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import {
	linkEvaluatorsToSpeakers,
	type MeetingSlotDefs,
} from "./meeting-create-logic";
import { lockMeetingForSlotEdit } from "./meeting-slot-lock";

export type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** A template as the picker shows it. */
export type MeetingTemplateSummary = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	defaultLengthMinutes: number | null;
};

/**
 * A picker choice plus its OWNER (#909): `null` for a GLOBAL template, the
 * club's id for one the club saved itself. The save dialog's replace list is
 * this read filtered to `clubId !== null`; the picker ignores the field.
 * A separate type rather than a field on `MeetingTemplateSummary` so the
 * picker's existing callers and fixtures need not change.
 */
export type AvailableTemplate = MeetingTemplateSummary & {
	clubId: string | null;
};

/**
 * Resolve a meeting to its club and gate the caller as an officer of it.
 *
 * Reshaping a meeting sits with reschedule and cancel, not with the
 * agenda-content edits ADR-0010 grants the self-asserted Toastmaster — a TMOD
 * may fill the agenda, not replace it. Note `requireClubRole(["admin"])` also
 * grants to any member holding an open `officer_terms` row (effective-admin,
 * #202), so the real authority here is every officer, not only a stored admin.
 *
 * Lives here, not in `meeting-templates.ts`, so a second server-fn module
 * (`meeting-agenda-edit.ts`) can import it too: a plain value export from a
 * module that also defines `createServerFn`s is exactly the leak
 * `server-modules.guard.test.ts` exists to catch, so this helper has to live
 * in a `*-logic.ts` sibling to be exported at all.
 */
export async function requireMeetingTemplateEditor(meetingId: string) {
	const user = await requireUser();
	const [meeting] = await database
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");
	await assertClubNotArchived(meeting.clubId);
	const membership = await requireClubRole(user.id, meeting.clubId, ["admin"]);
	return { clubId: meeting.clubId, membership };
}

/**
 * Templates this club may apply: every enabled GLOBAL template (`club_id IS
 * NULL`) plus its own.
 *
 * The tenant boundary lives in the QUERY, not in a `.filter()` a later
 * refactor can drop with every test still green. Phase 1 writes no club-scoped
 * rows, but writing the predicate now means Phase 2's editor cannot leak one
 * club's template to another — the same shape #544 and #560 had to be fixed for.
 */
export async function listAvailableTemplates(
	clubId: string,
): Promise<AvailableTemplate[]> {
	return database
		.select({
			id: meetingTemplates.id,
			clubId: meetingTemplates.clubId,
			key: meetingTemplates.key,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			defaultLengthMinutes: meetingTemplates.defaultLengthMinutes,
		})
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.enabled, true),
				// Private per-meeting copies are agendas, not choices. Excluded in
				// the QUERY rather than by a caller's `.filter()`, for the same
				// reason the tenant predicate is: a filter is droppable in a
				// refactor with every test still green.
				isNull(meetingTemplates.meetingId),
				or(
					isNull(meetingTemplates.clubId),
					eq(meetingTemplates.clubId, clubId),
				),
			),
		)
		.orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.name));
}

async function loadTemplateBeats(
	templateId: string,
): Promise<TemplateBeatRow[]> {
	return (
		database
			.select({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
				kind: meetingTemplateBeats.kind,
				label: meetingTemplateBeats.label,
				detail: meetingTemplateBeats.detail,
				minutes: meetingTemplateBeats.minutes,
				roleKey: meetingTemplateBeats.roleKey,
				repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
				flex: meetingTemplateBeats.flex,
				handoff: meetingTemplateBeats.handoff,
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
				// #683. This is the ONE read every render surface goes through, so
				// omitting it would leave every row looking ungoverned and quietly
				// refreeze every club's Table Topics window at its materialisation
				// snapshot. `TemplateBeatRow.clubGoverned` is required for exactly
				// that reason — the omission is invisible at runtime.
				clubGoverned: meetingTemplateBeats.clubGoverned,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder))
			// The cap is enforced HERE, at the one seam every renderer reads through,
			// rather than at the (currently seed-only) writer. Ordered by sortOrder,
			// so an oversized template renders its first N beats deterministically
			// instead of blocking the event loop. Without this the constant was
			// decorative — pinned by its own test, enforced by nothing, which is the
			// exact shape CLAUDE.md's "test stated relative to the constant" trap warns about.
			.limit(MAX_TEMPLATE_BEATS)
	);
}

async function loadTemplateRoles(
	templateId: string,
): Promise<TemplateRoleRow[]> {
	return (
		database
			.select({
				key: meetingTemplateRoles.key,
				name: meetingTemplateRoles.name,
				isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId))
			.orderBy(asc(meetingTemplateRoles.sortOrder))
			// See the beats loader above — same reason, same seam.
			.limit(MAX_TEMPLATE_ROLES)
	);
}

/**
 * A template's beats and roles. Null only when the row itself does not
 * exist — which, for a `meetings.template_id` pointer, means corruption,
 * since that FK is ON DELETE RESTRICT and the template therefore cannot have
 * been deleted.
 */
export async function loadTemplateContent(
	templateId: string,
): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null> {
	// THREE reads in parallel, not two. The existence check used to be inferred
	// from "both empty", which was free — but the editor can legitimately empty a
	// template, and inferring absence from emptiness turns "I deleted my last
	// row" into `meetings.ts` throwing and the meeting page going down. A third
	// parallel round trip adds no latency to `loadMeetingDetail`'s critical path,
	// which is what the old comment was protecting.
	const [beats, roles, exists] = await Promise.all([
		loadTemplateBeats(templateId),
		loadTemplateRoles(templateId),
		database
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, templateId))
			.limit(1),
	]);
	if (exists.length === 0) return null;
	return { beats, roles };
}

/**
 * The `key` of a template row, or null if it no longer exists.
 *
 * Exists so a caller can tell an officer WHICH listed choice a meeting is
 * currently running without matching on `meetings.template_id` itself — a
 * private copy's own id is fresh every conversion and never equals anything
 * `listAvailableTemplates` offers, but it keeps its SOURCE's `key` verbatim
 * (see `copyTemplateForMeeting`), so `key` is the stable thing to match a
 * picker choice against. `meeting-agenda.tsx` uses this to compute the
 * "Current" badge in `MeetingTemplateDialog`.
 */
export async function loadTemplateKey(
	templateId: string,
): Promise<string | null> {
	const [row] = await database
		.select({ key: meetingTemplates.key })
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, templateId))
		.limit(1);
	return row?.key ?? null;
}

/**
 * The club's role BANK — every `role_definitions` row it owns, standing or not.
 *
 * Narrowed to club-only by #801. It used to carry a template axis too
 * (`roleDefScopeOnly`, an exclusive OR on `template_id`), and that either/or is
 * exactly what made the reported bug unrecoverable from the UI: a meeting on a
 * custom agenda could see ONLY that agenda's role definitions, never its own
 * club's bank, so attaching the club's Timer to a special meeting was
 * unreachable and the officer fell through to the free-text form, which forked.
 *
 * SCOPE ONLY — deliberately no `enabled` and no `standing` filter. Callers
 * apply those where they belong: `slots-logic`'s `applyAddRoleSlot`
 * distinguishes "role not found" from "this role is currently disabled", and
 * filtering here would make the first silently answer for the second.
 */
export function roleDefScope(clubId: string) {
	return eq(roleDefinitions.clubId, clubId);
}

/** A declaration resolved onto the club's bank: the DECLARATION's shape
 *  columns, the BANK's identity columns.
 *
 *  `standing` is REQUIRED here, narrowing `SlotGenInput`'s optional field. It
 *  is optional there so a fixture need not invent it; it is required here
 *  because every producer of this type either reads the column or synthesizes
 *  it deliberately, and the two backfills in `slots-logic` gate on it. A
 *  resolver that forgot it should not compile. */
type DeclaredRoleDef = MeetingSlotDefs & RoleIdentity & { standing: boolean };

/**
 * The bank rows a template's declarations resolve to, joined by (club, key).
 *
 * PURE READ, and the shape half of the split #801 introduced: which roles a
 * meeting uses, how many places and in what order comes from
 * `meeting_template_roles`; WHICH ROW each one is — the id every history query
 * joins on, and the name the club actually calls it — comes from the bank. A
 * declared key with no bank row is simply absent here; `materializeTemplateRoles`
 * is what mints it.
 *
 * `standing` and `enabled` are SYNTHESIZED true. This is the seam that makes
 * "the declaration outranks the flags" true, and it has to live here:
 * `generateSlotRows` is a pure function over `SlotGenInput` with no meeting
 * context, so it cannot tell a templated meeting from a standard one and must
 * stay a dumb filter over the flags it is handed. A contest's Chief Judge is
 * non-standing in the bank precisely so it never lands on an ordinary meeting,
 * and it still has to generate its slot on the contest itself.
 */
async function loadDeclaredRoleDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string,
): Promise<DeclaredRoleDef[]> {
	const rows = await conn
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			category: roleDefinitions.category,
			key: meetingTemplateRoles.key,
			defaultCount: meetingTemplateRoles.defaultCount,
			sortOrder: meetingTemplateRoles.sortOrder,
			isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
		})
		.from(meetingTemplateRoles)
		.innerJoin(
			roleDefinitions,
			and(
				eq(roleDefinitions.clubId, clubId),
				eq(roleDefinitions.key, meetingTemplateRoles.key),
			),
		)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder), asc(roleDefinitions.name));
	return rows.map((r) => ({ ...r, standing: true, enabled: true }));
}

/**
 * Resolve a template's declared roles against the club's BANK, minting a bank
 * row only for a key the club genuinely does not have yet.
 *
 * This replaced a copy (#801). It used to insert one `role_definitions` row per
 * declaration, tagged `template_id`, on EVERY conversion — and since
 * `applyTemplateConversion` deep-copies the template first, re-converting the
 * same meeting minted another full set under a fresh template id, with no
 * ceiling. Three standard functionaries hand-added to a live club's special
 * meeting carried no history for exactly that reason: the slot pointed at a
 * fork, and `loadRoleRecency` and the season grid both key on
 * `role_slots.role_definition_id`.
 *
 * A minted row is NON-STANDING: it is the club's role now — attachable,
 * manageable in /admin/roles, and the target of every future history query for
 * that key — but it is not part of the club's standard meeting shape, so no
 * ordinary meeting generates a slot for it. `standing`, not `enabled`: see
 * `role_definitions.standing` in `schema.ts` for why folding the two breaks in
 * both directions.
 *
 * `DO NOTHING` rather than `DO UPDATE`, as before, so a club's own rename of a
 * role survives every later re-application — the club's name is what every
 * surface labels with (#445). Idempotent: a second call resolves every key and
 * mints nothing.
 *
 * Required at all because `role_slots.role_definition_id` is NOT NULL and
 * restricting: a claimable contest role has to be a real `role_definitions` row.
 */
export async function materializeTemplateRoles(
	conn: DbOrTx,
	clubId: string,
	templateId: string,
): Promise<void> {
	const declared = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));
	if (declared.length === 0) return;

	const bank = await conn
		.select({ key: roleDefinitions.key })
		.from(roleDefinitions)
		.where(
			and(
				roleDefScope(clubId),
				inArray(
					roleDefinitions.key,
					declared.map((r) => r.key),
				),
			),
		);
	const held = new Set(bank.flatMap((r) => (r.key == null ? [] : [r.key])));

	// `slots_unordered` is the one declared column a RESOLVE still has to carry
	// onto an existing bank row, and it is carried ONE WAY: false → true, never
	// back.
	//
	// It is not a club preference. #624 made it a fact about the SHAPE — a
	// contest's speaking order is drawn by lot at the briefing, after the sheet
	// has printed, so `slotLabel` must print a bare "Contestant" rather than
	// asserting "Contestant 1..N" off sign-up order. Under the per-template
	// model every conversion copied the declaration's value onto a fresh row and
	// the question never arose; resolving onto an existing bank row, it does —
	// a club holding `contestant_prepared` at false (minted by `addAgendaRole`'s
	// create path, which has no such field to set) would number its contestants
	// again with every gate green.
	//
	// Every live reader takes the flag off the BANK ROW — `meeting-slots-logic`,
	// and three reads in `meeting-agenda-edit-logic`; the only references to
	// `meetingTemplateRoles.slotsUnordered` outside the two writers here are in
	// test files. So carrying it on `DeclaredRoleDef` would be decoration, and
	// this UPDATE is where the correction actually lands.
	//
	// ONE WAY because the flag is read at RENDER time off a club-wide row: a
	// full sync would let two shapes declaring the same key differently flap it
	// back and forth, and the last conversion would change how an OLDER
	// meeting's roster prints. Raising is monotone, and can only ever collapse
	// numbering for a role some shape says is unordered.
	const raise = declared
		.filter((r) => r.slotsUnordered && held.has(r.key))
		.map((r) => r.key);
	if (raise.length > 0) {
		await conn
			.update(roleDefinitions)
			.set({ slotsUnordered: true })
			.where(
				and(
					roleDefScope(clubId),
					inArray(roleDefinitions.key, raise),
					eq(roleDefinitions.slotsUnordered, false),
				),
			);
	}

	const missing = declared.filter((r) => !held.has(r.key));
	if (missing.length === 0) return;

	await conn
		.insert(roleDefinitions)
		.values(
			missing.map((r) => ({
				clubId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				slotsUnordered: r.slotsUnordered,
				description: r.description,
				// Its own club's role from here on, but NOT part of the club's
				// standard meeting shape.
				standing: false,
			})),
		)
		// Two officers converting two meetings to the same template at once both
		// read an empty bank for a key. `role_definitions_club_key_unique` settles
		// it; this makes the loser a no-op rather than a 500.
		.onConflictDoNothing();
}

/**
 * A template `clubId` may legally copy FROM: global, or the club's own,
 * excluding private per-meeting copies. Same shape as `listAvailableTemplates`
 * (`:61-88`) — deliberately re-expressed rather than shared, since that query
 * also requires `enabled`, which a source lookup must not: a meeting already
 * running a template a club later disabled still has to be re-copyable when
 * re-converting or re-applying it.
 *
 * `meeting_templates` gained its first per-club (and per-meeting) rows in the
 * same change that added `copyTemplateForMeeting`. Before that, a caller-
 * supplied template id was safe to trust unscoped — every row was global and
 * world-readable by design. It no longer is: `applyTemplateToMeeting` passes
 * the caller's `templateId` straight through with no ownership check of its
 * own, and meeting ids (hence a meeting's private-copy id, readable off its
 * own `meetings.template_id`) are public. Without this predicate, an admin of
 * ANY club could name another club's private copy as the source and deep-copy
 * that club's authored agenda into their own.
 */
function templateVisibleTo(clubId: string) {
	return and(
		or(isNull(meetingTemplates.clubId), eq(meetingTemplates.clubId, clubId)),
		isNull(meetingTemplates.meetingId),
	);
}

/**
 * Copy one template's roles and beats onto another template row, and nothing
 * else — the row itself (name, key, owner) is the caller's.
 *
 * Extracted from `copyTemplateForMeeting` (#909) so saving a meeting's agenda
 * as a club template copies through the SAME column list rather than a second
 * one that drifts: an explicit list is only safe while it is complete, and two
 * of them are two chances to forget the next column.
 *
 * `id` and `template_id` are the only columns not carried: the first is
 * regenerated, the second is `toTemplateId`. Beats reference roles by KEY
 * (`role_key`, `repeats_role_key`), never by id, which is why the two tables
 * copy with no remapping between them.
 *
 * NO visibility check — `fromTemplateId` is trusted. Every caller resolves it
 * first: `copyTemplateForMeeting` through `templateVisibleTo`, the club-template
 * save from the meeting's own `template_id` pointer. Multi-statement and not
 * self-transactional, like `copyTemplateForMeeting`: run it inside the caller's
 * transaction.
 */
export async function copyTemplateContent(
	conn: DbOrTx,
	input: { fromTemplateId: string; toTemplateId: string },
): Promise<void> {
	const { fromTemplateId, toTemplateId } = input;
	// FOR SHARE on the SOURCE row before reading either table (#909 review).
	// Roles and beats are two reads; without this a replace committing between
	// them left a copy with the OLD roles and the NEW beats, and `toRow` then
	// silently drops every beat naming a role the old set does not declare. A
	// replace takes this row FOR UPDATE before it swaps the content, so the two
	// serialise: a copy sees the content wholly before the swap or wholly
	// after. Every copier goes through here — conversion, the first-edit fork
	// in `ensureAgendaDraft`, and `forkLegacyPointers`.
	await conn
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, fromTemplateId))
		.for("share");
	const roles = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, fromTemplateId));
	if (roles.length > 0) {
		await conn.insert(meetingTemplateRoles).values(
			roles.map((r) => ({
				templateId: toTemplateId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				slotsUnordered: r.slotsUnordered,
				description: r.description,
			})),
		);
	}

	// Bounded, and REFUSES rather than truncating. Safe until now only because
	// every source was a seeded template whose size the seed fixes; #622 lets an
	// officer-authored template be a source, which makes this an officer-sized
	// read. Fetching one MORE than the cap is what makes the check possible
	// without an unbounded select. A silently shortened agenda is a meeting that
	// runs off the end of its booking with nothing on the sheet to say so.
	const beats = await conn
		.select()
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, fromTemplateId))
		.orderBy(asc(meetingTemplateBeats.sortOrder))
		.limit(MAX_TEMPLATE_BEATS + 1);
	if (beats.length > MAX_TEMPLATE_BEATS) {
		throw new Error(
			`That agenda is too large to copy (${MAX_TEMPLATE_BEATS} rows maximum).`,
		);
	}
	if (beats.length > 0) {
		// EVERY content column, which `findRow`'s docblock already assumed ("a fork
		// copies every column verbatim") and this list did not deliver: `handoff`
		// was missing, so a fork silently flattened the indented "X introduces Y"
		// elbows into ordinary rows. Not reachable today — no shared template
		// declares a hand-off — but it is the same omission `club_governed` would
		// have been, and an explicit list is only safe while it is complete.
		await conn.insert(meetingTemplateBeats).values(
			beats.map((b) => ({
				templateId: toTemplateId,
				sortOrder: b.sortOrder,
				kind: b.kind,
				label: b.label,
				detail: b.detail,
				minutes: b.minutes,
				roleKey: b.roleKey,
				repeatsRoleKey: b.repeatsRoleKey,
				flex: b.flex,
				handoff: b.handoff,
				markGreen: b.markGreen,
				markYellow: b.markYellow,
				markRed: b.markRed,
				clubGoverned: b.clubGoverned,
			})),
		);
	}
}

/**
 * Deep-copy a template into a PRIVATE row owned by one meeting, and return the
 * copy's id.
 *
 * This is what makes an agenda editable: the meeting points at content nobody
 * else reads, so removing a row from one contest cannot remove it from the next
 * one, and "save this shape as a template" later is a promotion (clear
 * `meeting_id`) rather than a second mechanism.
 *
 * The copy keeps the SOURCE's `key`. It is unique per meeting via
 * `meeting_templates_meeting_unique`, and the club-key index exempts private
 * rows, so the key here is provenance rather than identity — it is how you can
 * still tell what a meeting was built from after it has been edited.
 *
 * `sourceTemplateId` is gated by `templateVisibleTo(clubId)` — this is the
 * boundary that keeps one club from naming another's private copy as a
 * source, so it must run inside the SAME transaction as everything else this
 * function does: it is multi-statement but not self-transactional, and a
 * caller invoking it outside a transaction risks a mid-copy failure leaving a
 * template row with partial roles and beats.
 */
export async function copyTemplateForMeeting(
	conn: DbOrTx,
	input: { sourceTemplateId: string; clubId: string; meetingId: string },
): Promise<string> {
	const { sourceTemplateId, clubId, meetingId } = input;
	const [source] = await conn
		.select()
		.from(meetingTemplates)
		.where(
			and(eq(meetingTemplates.id, sourceTemplateId), templateVisibleTo(clubId)),
		)
		.limit(1);
	if (!source) throw new Error("That meeting template no longer exists.");

	const [copy] = await conn
		.insert(meetingTemplates)
		.values({
			clubId,
			meetingId,
			key: source.key,
			name: source.name,
			description: source.description,
			defaultLengthMinutes: source.defaultLengthMinutes,
			sortOrder: source.sortOrder,
			enabled: source.enabled,
		})
		.returning({ id: meetingTemplates.id });
	if (!copy) throw new Error("Failed to copy the meeting template.");

	await copyTemplateContent(conn, {
		fromTemplateId: sourceTemplateId,
		toTemplateId: copy.id,
	});

	return copy.id;
}

/**
 * The role definitions a meeting's slots are generated from: the club's
 * STANDING, enabled bank roles when there is no template, the template's
 * declarations resolved onto the bank when there is.
 *
 * WRITES, on one narrow path, and its docblock used to say the opposite. It
 * promised a PURE READ because "a function named `resolve…` that quietly
 * INSERTs is a surprise for the next caller" — a claim about future callers,
 * so #801 rewrote the claim rather than leaving it contradicting the code.
 * What made it safe to change is that the surprise it was protecting against
 * never materialised: `resolveMeetingRoleDefs` has exactly ONE non-test caller,
 * `applyTemplateConversion`, already inside `database.transaction`. Rendering a
 * templated meeting never comes here (the meeting page joins `role_slots` to
 * `role_definitions` directly), and the conversion PREVIEW still does not —
 * it goes through `resolveConversionTargetRoles`, which reads the template's
 * own declarations and writes nothing.
 *
 * The write is `materializeTemplateRoles`: a declared key with no bank row
 * mints one at `standing = false` rather than resolving to nothing. Reachable
 * for a template authored but never materialized for this club, and for a
 * declaration stranded by a bank-role delete. It mirrors the precedent
 * `materialiseForMeeting` set for the same question
 * (`meeting-agenda-edit-logic.ts`): an unresolvable key falls back rather than
 * dropping the row, because a row owned by nobody is what an unstaffed role
 * already looks like. IDEMPOTENT — a second resolve mints nothing, because the
 * first one's rows now resolve by key.
 *
 * The two arms differ in which flags they honour, and deliberately.
 * `standing AND enabled` is the club's own switchboard over its OWN standard
 * shape. A template's roles are the contest's fixed shape, not a menu:
 * `loadDeclaredRoleDefs` synthesizes both flags true, so honouring the bank's
 * copy would silently drop a required position from the run of show.
 */
export async function resolveMeetingRoleDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
): Promise<DeclaredRoleDef[]> {
	if (templateId !== null)
		await materializeTemplateRoles(conn, clubId, templateId);
	return loadMeetingShapeDefs(conn, clubId, templateId, { onlyEnabled: true });
}

/**
 * PURE READ of the same rule `resolveMeetingRoleDefs` resolves: which role
 * definitions make up this meeting's SHAPE. Never mints.
 *
 * The seam `slots-logic` reads through, and it is the reason the reported bug
 * has two halves rather than one. "Which roles is this meeting made of" and
 * "which roles may an officer attach to it" used to be the same query with the
 * same either/or predicate, so scoping the first correctly (a contest's
 * "+ Add speaker" must resolve Contestant, not the club's Speaker) forced the
 * second to be wrong (a contest's "+ Add role" could not reach the club's
 * Timer). Two functions now: this one for shape, `roleDefScope` for the bank.
 *
 * `onlyEnabled` applies to the STANDARD arm only, and there is nothing to apply
 * on the other: a declaration-resolved row synthesizes `enabled: true` because
 * the declaration is the authority for a templated meeting. The standard arm's
 * callers split on it — `generateSlotRows`' inputs want enabled roles only,
 * while `clubRoles` needs the unfiltered set to tell "the club's Speaker is
 * disabled" from "this club has no speaker role".
 */
export async function loadMeetingShapeDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
	opts?: { onlyEnabled?: boolean },
): Promise<DeclaredRoleDef[]> {
	if (templateId !== null)
		return loadDeclaredRoleDefs(conn, clubId, templateId);
	const where = [roleDefScope(clubId), eq(roleDefinitions.standing, true)];
	if (opts?.onlyEnabled) where.push(eq(roleDefinitions.enabled, true));
	return conn
		.select({
			id: roleDefinitions.id,
			defaultCount: roleDefinitions.defaultCount,
			enabled: roleDefinitions.enabled,
			standing: roleDefinitions.standing,
			category: roleDefinitions.category,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			sortOrder: roleDefinitions.sortOrder,
			// The conversion matches on these, not on `id` — see
			// `matchRoleDefs`. Selected here rather than in a second round trip
			// so the preview and the apply read one shape.
			key: roleDefinitions.key,
			name: roleDefinitions.name,
		})
		.from(roleDefinitions)
		.where(and(...where))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name));
}

// ---------------------------------------------------------------------------
// Conversion — switching a meeting's shape to (or away from) a template.
// ---------------------------------------------------------------------------

/** A member or guest whose slot the conversion released. */
export type ReleasedHolder = {
	memberId: string | null;
	guestId: string | null;
	name: string;
	roleName: string;
};

/** What a conversion will do (preview) or did (apply). */
export type ConversionPlan = {
	openSlotsRemoved: number;
	claimedSlotsReleased: number;
	slotsWithSpeeches: number;
	/** Slots the conversion will CREATE. The dialog promises this number
	 *  ("adds 17 contest roles"), and on a first-time preview it cannot come from
	 *  `role_definitions` — nothing is materialized yet, by design, because the
	 *  preview must not write. So it is read from the TEMPLATE's own rows and
	 *  reduced by whatever already exists. */
	slotsAdded: number;
	releasedHolders: ReleasedHolder[];
};

/** This meeting's slots, annotated with role name and assignee name. */
async function loadSlotsForConversion(conn: DbOrTx, meetingId: string) {
	return conn
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			roleName: roleDefinitions.name,
			// The stable identity the conversion keeps a slot BY. Without it,
			// "does this role survive" could only be asked of a `role_definitions`
			// id, which is fresh on every copy — see `matchRoleDefs`.
			roleKey: roleDefinitions.key,
			assignedMemberId: roleSlots.assignedMemberId,
			assignedGuestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
			speechId: roleSlots.speechId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleSlots.roleDefinitionId, roleDefinitions.id),
		)
		.leftJoin(members, eq(roleSlots.assignedMemberId, members.id))
		.leftJoin(guests, eq(roleSlots.assignedGuestId, guests.id))
		.where(eq(roleSlots.meetingId, meetingId));
}

/** A role the conversion will END UP with, as both sides can see it. */
type TargetRole = RoleIdentity & { defaultCount: number };

/**
 * The role set a conversion to `templateId` INSTALLS, resolved the one way
 * both the preview and the apply can resolve it.
 *
 * For a template it is the template's own `meeting_template_roles`, NOT the
 * materialized `role_definitions`: the apply deep-copies the template
 * (`copyTemplateForMeeting`) and materializes the copy's roles
 * (`materializeTemplateRoles`), which is a field-for-field reproduction of
 * exactly these rows under a fresh `template_id`. Reading `role_definitions`
 * under the SOURCE id instead is what made the preview and the apply disagree:
 * the preview saw the defs a pre-private-copy conversion had materialized
 * there, badged the target "Current", and reported a no-op — while the apply
 * built a brand-new copy whose defs share none of those ids and released every
 * claim. Same predicate, different ARGUMENT.
 *
 * For `null` it is the club's own STANDING, enabled roles, which the apply
 * reads through `resolveMeetingRoleDefs(conn, clubId, null)` — the same rows,
 * no copy involved. Both flags, matching that function exactly: a non-standing
 * bank role (a promoted contest role, or one an officer added from an agenda)
 * is not part of the club's standard shape, so converting a meeting BACK to
 * standard must neither keep nor create a slot for it.
 */
async function resolveConversionTargetRoles(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
): Promise<TargetRole[]> {
	if (templateId === null) {
		return conn
			.select({
				key: roleDefinitions.key,
				name: roleDefinitions.name,
				defaultCount: roleDefinitions.defaultCount,
			})
			.from(roleDefinitions)
			.where(
				and(
					roleDefScope(clubId),
					eq(roleDefinitions.standing, true),
					eq(roleDefinitions.enabled, true),
				),
			);
	}
	return conn
		.select({
			key: meetingTemplateRoles.key,
			name: meetingTemplateRoles.name,
			defaultCount: meetingTemplateRoles.defaultCount,
		})
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId));
}

/**
 * The whole derivation, run identically by the preview and the apply.
 *
 * Returns the counts the dialog shows AND the old-definition → new-definition
 * map the apply re-points slots through, from ONE call — which is what makes
 * "preview and apply agree" a property of the code rather than of two call
 * sites staying in sync.
 */
function planConversion<T extends TargetRole>(
	current: Awaited<ReturnType<typeof loadSlotsForConversion>>,
	target: T[],
): { plan: ConversionPlan; matched: Map<string, T> } {
	const matched = matchRoleDefs(distinctRoleDefs(current), target);
	return {
		plan: summarize(
			current,
			new Set(matched.keys()),
			target.reduce((n, r) => n + r.defaultCount, 0),
		),
		matched,
	};
}

function summarize(
	current: Awaited<ReturnType<typeof loadSlotsForConversion>>,
	keepDefIds: Set<string>,
	targetSlotCount: number,
): ConversionPlan {
	const doomed = current.filter((s) => !keepDefIds.has(s.roleDefinitionId));
	const held = doomed.filter((s) => s.assignedMemberId || s.assignedGuestId);
	const kept = current.length - doomed.length;
	return {
		openSlotsRemoved: doomed.length - held.length,
		claimedSlotsReleased: held.length,
		slotsWithSpeeches: doomed.filter((s) => s.speechId !== null).length,
		// Never negative: a re-apply keeps every slot, so target minus kept is 0.
		slotsAdded: Math.max(0, targetSlotCount - kept),
		releasedHolders: held.map((s) => ({
			memberId: s.assignedMemberId,
			guestId: s.assignedGuestId,
			name: s.memberName ?? s.guestName ?? "Someone",
			roleName: s.roleName,
		})),
	};
}

/**
 * What applying `templateId` to this meeting WOULD do. Read-only.
 *
 * The confirmation dialog shows these counts before anything is destroyed,
 * which is the whole reason converting a meeting with live claims on it is
 * allowed at all.
 *
 * It runs the SAME derivation the apply runs — `resolveConversionTargetRoles`
 * then `planConversion` — over the same two inputs, so the two cannot disagree
 * about what gets kept. That is the one thing this dialog exists to guarantee,
 * and it was FALSE until this was written: the docblock used to claim the
 * shared `roleDefScope` predicate was enough, but the preview passed it the
 * SOURCE template's id while the apply passed a brand-new private copy's, so
 * for any meeting whose definitions were materialized under the source id
 * (every meeting converted before private copies existed) re-picking the entry
 * badged "Current" previewed as a no-op and then released every claim. A
 * shared predicate given a different argument is not a shared answer.
 *
 * Nothing here is a second copy of the apply's rule: the target roles come
 * from the template's own declarations, which is precisely what the apply is
 * about to materialize, and the keep/drop decision is `matchRoleDefs`.
 */
export async function planTemplateConversion(
	meetingId: string,
	templateId: string | null,
): Promise<ConversionPlan> {
	const [meeting] = await database
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");

	// Same tenant boundary `copyTemplateForMeeting` and `applyTemplateConversion`
	// already enforce on the WRITE path (see that function's docblock):
	// `templateId` is caller-supplied and, now that private per-meeting copies
	// exist, unsafe to trust unscoped — without this, a club-B admin who has
	// read a club-A private template's id off a public meeting page could
	// preview against it and learn its role count below. Throwing the same
	// "no longer exists" error the write path throws — rather than silently
	// returning a zeroed plan — keeps the two paths agreeing about what a
	// caller may even address; a caller that cannot APPLY a template should not
	// be able to PREVIEW it either.
	if (templateId !== null) {
		const [visible] = await database
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(
					eq(meetingTemplates.id, templateId),
					templateVisibleTo(meeting.clubId),
				),
			)
			.limit(1);
		if (!visible) throw new Error("That meeting template no longer exists.");
	}

	const current = await loadSlotsForConversion(database, meetingId);

	// Preview must NOT materialize: a preview that writes would litter a club's
	// role_definitions with templates nobody applied. Reading the template's own
	// declarations rather than its materialized copies is what makes that
	// possible AND what makes this exact — see `resolveConversionTargetRoles`.
	const target = await resolveConversionTargetRoles(
		database,
		meeting.clubId,
		templateId,
	);
	return planConversion(current, target).plan;
}

/**
 * Apply a template to an existing meeting, or `null` to convert it back to the
 * club's standard shape. ONE transaction.
 *
 * Released holders are RETURNED, never enqueued on `notifications`:
 * `notifications.slot_id` is NOT NULL and ON DELETE CASCADE to `role_slots`, so
 * a row enqueued against a slot this transaction then deletes is cascade-deleted
 * before the poller could ever see it — a notification that silently never
 * sends. The caller surfaces the existing WhatsApp nudge against each name.
 *
 * Authorization is the CALLER's: this function has no session. The server fn
 * gates on the club role and the archive state before calling it.
 */
export async function applyTemplateConversion(input: {
	meetingId: string;
	clubId: string;
	templateId: string | null;
	actorMemberId: string | null;
}): Promise<ConversionPlan> {
	const { meetingId, clubId, templateId, actorMemberId } = input;

	// Fail fast, before opening a transaction. Gated by `templateVisibleTo` for
	// the same reason `copyTemplateForMeeting`'s own read is (see that
	// function's docblock): `templateId` is caller-supplied —
	// `applyTemplateToMeeting` passes it straight through, checking only the
	// TARGET meeting's club — and, now that private per-meeting copies exist,
	// no longer safe to trust as globally readable. This duplicates
	// `copyTemplateForMeeting`'s own gate rather than relying on it alone,
	// so the caller-facing error and the no-lock-taken failure happen here,
	// before the transaction below does any work.
	if (templateId !== null) {
		const [visible] = await database
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(eq(meetingTemplates.id, templateId), templateVisibleTo(clubId)),
			)
			.limit(1);
		if (!visible) throw new Error("That meeting template no longer exists.");
	}

	return database.transaction(async (tx) => {
		// Lock before copying templates or reading slots: the conversion plan must
		// include slot edits committed while we waited.
		const meeting = await lockMeetingForSlotEdit(tx, meetingId);
		if (meeting.clubId !== clubId) throw new Error("Meeting not found.");
		// The canonical lock (#150 / ADR-0012) covers `completed`. A CANCELLED
		// meeting is not locked by it, but reshaping one is equally pointless, so
		// it is refused here rather than by widening the shared helper — every
		// other mutator's meaning of "locked" stays exactly as it was.
		assertMeetingNotLocked(meeting.status);
		if (meeting.status === "cancelled") {
			throw new Error("A cancelled meeting cannot change its template.");
		}

		// The meeting's CURRENT private template, if it has one — captured before
		// we repoint, because that is what we must retire afterwards.
		const previousPrivateId = meeting.templateId
			? ((
					await tx
						.select({ id: meetingTemplates.id })
						.from(meetingTemplates)
						.where(
							and(
								eq(meetingTemplates.id, meeting.templateId),
								eq(meetingTemplates.meetingId, meetingId),
							),
						)
						.limit(1)
				)[0]?.id ?? null)
			: null;

		// Detach (never delete-in-place) the outgoing private copy FIRST.
		// `meeting_templates_meeting_unique` is a bare unique INDEX, not a
		// deferrable constraint, so it is enforced the instant
		// `copyTemplateForMeeting`'s INSERT runs below — the old row's own
		// `meeting_id` has to be cleared before that insert, not after.
		// (Nulling `meetings.template_id` would not do this: that column and
		// `meeting_templates.meeting_id` are different columns on different
		// tables.) The row still can't be DELETEd here, for the one remaining
		// reason: `meetings.template_id` is ON DELETE RESTRICT and still points
		// at it until the update near the end of this transaction. Since #801 no
		// `role_definitions` row points at a template at all, so the second,
		// independent RESTRICT this used to have to unwind is gone.
		//
		// The KEY moves too (#909). Clearing `meeting_id` makes the row look
		// club-owned for the rest of this transaction, so it falls under
		// `meeting_templates_club_key_unique` — and a private copy keeps its
		// SOURCE's key. Once a club can save its own templates, a meeting running
		// a copy of "contest-night" detaches a row keyed `contest-night` beside the
		// club template of that key, and re-applying ANY template to that meeting
		// failed on the unique index. A per-row key cannot collide, and the row is
		// deleted below before anything outside this transaction can see it.
		// The prefix is one no slug can produce (`retiredTemplateKey`).
		if (previousPrivateId !== null) {
			await tx
				.update(meetingTemplates)
				.set({ meetingId: null, key: retiredTemplateKey(previousPrivateId) })
				.where(eq(meetingTemplates.id, previousPrivateId));
		}

		// Deep-copy so this meeting's agenda is its own. Re-converting makes a
		// FRESH copy, which is what keeps an edited contest from leaking into the
		// next one.
		const effectiveTemplateId =
			templateId === null
				? null
				: await copyTemplateForMeeting(tx, {
						sourceTemplateId: templateId,
						clubId,
						meetingId,
					});

		// Resolving a templated meeting's defs MINTS a bank row for any declared
		// key the club does not hold yet — see `resolveMeetingRoleDefs`, which
		// used to promise a pure read and no longer does. Idempotent, and this
		// call is the only writer, so the step no longer needs spelling out
		// separately here.
		const defs = await resolveMeetingRoleDefs(tx, clubId, effectiveTemplateId);
		const current = await loadSlotsForConversion(tx, meetingId);
		// The SAME derivation `planTemplateConversion` ran — `matchRoleDefs` over
		// the current definitions and the target ones. `defs` carry the template's
		// own declaration keys verbatim, which is exactly what the preview matched
		// against; since #801 they also carry the same BANK ids the meeting's
		// slots already point at, which is what makes the loop below a no-op.
		const { plan, matched } = planConversion(current, defs);
		const keepDefIds = new Set(matched.keys());

		// Re-point, do not tear down. A slot whose role the target set still
		// declares is the SAME role — the officer re-picked the shape it already
		// had, or moved to a template that shares the position — so the member
		// who claimed it keeps it.
		//
		// A NO-OP for every matched role since #801: both sides live in the bank's
		// one id space, so `def.id === oldDefId` and the `continue` below fires
		// every time. Kept rather than deleted because `matchRoleDefs` can still
		// legitimately map two ids together — an unkeyed legacy row matched by
		// name onto a keyed bank row is the case the migration's step 1 could not
		// fold — and a slot pointing at the loser still has to move. What is gone
		// is the id churn a conversion used to cause on EVERY role.
		//
		// It was never a nicety: a released holder CANNOT be notified
		// (`notifications.slot_id` is NOT NULL and cascades from `role_slots`,
		// see this function's docblock), so every avoidable release is a member
		// who silently loses a role they agreed to.
		for (const [oldDefId, def] of matched) {
			if (def.id === oldDefId) continue;
			await tx
				.update(roleSlots)
				.set({ roleDefinitionId: def.id })
				.where(
					and(
						eq(roleSlots.meetingId, meetingId),
						eq(roleSlots.roleDefinitionId, oldDefId),
					),
				);
		}

		const doomedIds = current
			.filter((s) => !keepDefIds.has(s.roleDefinitionId))
			.map((s) => s.id);
		if (doomedIds.length > 0) {
			// Release first, then delete. Clearing the assignee and the speech
			// pointer in their own statement keeps "a slot is released before it
			// disappears" true at every intermediate state. The speech itself is
			// Person-owned (ADR-0009), so it survives regardless.
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					speechId: null,
					status: "open",
					claimedAt: null,
				})
				.where(inArray(roleSlots.id, doomedIds));
			await tx.delete(roleSlots).where(inArray(roleSlots.id, doomedIds));
		}

		// The NEW ids the kept slots now point at, not the old ones they came in
		// with — `toCreate` below asks "which target roles still have no slot on
		// this meeting", and after the re-point above that question is only
		// answerable in the target set's own id space.
		const existingDefIds = new Set(
			current
				.map((s) => matched.get(s.roleDefinitionId)?.id)
				.filter((id): id is string => id !== undefined),
		);
		const toCreate = defs.filter((d) => !existingDefIds.has(d.id));
		if (toCreate.length > 0) {
			const rows = generateSlotRows(toCreate, meetingId);
			if (rows.length > 0) {
				const inserted = await tx.insert(roleSlots).values(rows).returning({
					id: roleSlots.id,
					roleDefinitionId: roleSlots.roleDefinitionId,
					slotIndex: roleSlots.slotIndex,
				});
				await linkEvaluatorsToSpeakers(tx, inserted, defs);
			}
		}

		const length =
			effectiveTemplateId === null
				? null
				: ((
						await tx
							.select({ m: meetingTemplates.defaultLengthMinutes })
							.from(meetingTemplates)
							.where(eq(meetingTemplates.id, effectiveTemplateId))
							.limit(1)
					)[0]?.m ?? null);

		await tx
			.update(meetings)
			.set({
				templateId: effectiveTemplateId,
				...(length != null ? { lengthMinutes: length } : {}),
			})
			.where(eq(meetings.id, meetingId));

		// Retire the superseded private copy now, not earlier: `meetings.template_id`
		// no longer references it (just updated above, satisfying its own RESTRICT).
		//
		// The `meeting_templates` row and nothing else. This used to delete the
		// copy's `role_definitions` first, because those were per-copy rows that
		// held a second, independent RESTRICT against it — the fork mechanism #801
		// deleted. Under bank identity there ARE no per-copy definitions to
		// retire: the outgoing copy's declarations resolved onto the club's own
		// bank rows, which the new shape may well still be using and which carry
		// this meeting's history either way. Deleting a bank row here would either
		// hit `role_slots.role_definition_id`'s RESTRICT from a sibling meeting or
		// destroy the club's Timer. The declarations themselves cascade with the
		// template row.
		if (previousPrivateId !== null) {
			await tx
				.delete(meetingTemplates)
				.where(eq(meetingTemplates.id, previousPrivateId));
		}

		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "meeting_template_set",
			targetType: "meeting",
			targetId: meetingId,
			detail: { templateId, privateTemplateId: effectiveTemplateId },
		});

		return plan;
	});
}

// ---------------------------------------------------------------------------
// Save a meeting's agenda as a club template (#909)
// ---------------------------------------------------------------------------

/** The one sentence every path that cannot find a club template uses. */
export const CLUB_TEMPLATE_GONE_MESSAGE =
	"That club template no longer exists.";

/** What a lost key race reads as. The index is the backstop the read under the
 *  club lock should make unreachable; this is what it says if it is not. */
export const CLUB_TEMPLATE_KEY_RACE_MESSAGE =
	"Someone else just saved a template with that name. Try again.";

/**
 * The key a NEW club template named `name` is saved under: the name's slug,
 * or the first free `slug-N` beside the club's existing club-owned keys.
 *
 * Reads under `FOR NO KEY UPDATE` on the CLUB row, so two officers saving
 * "Contest night" at the same moment serialise here and the second one sees
 * the first one's key. Must run inside the caller's transaction or the lock is
 * released before the insert it exists to protect. A caller that has written
 * anything referencing the club earlier in its transaction must take this lock
 * FIRST itself (see `saveMeetingAgendaAsClubTemplate`): the lock here is then a
 * no-op re-acquire, and taking it late is a deadlock against a second saver. Scoped to `meeting_id IS NULL` —
 * exactly the rows `meeting_templates_club_key_unique` covers; a private copy
 * keeping its source's key is not a collision.
 *
 * Exported for #910, which mints club templates by adoption.
 */
export async function nextClubTemplateKey(
	tx: DbOrTx,
	clubId: string,
	name: string,
): Promise<string> {
	await tx
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.for("no key update")
		.limit(1);
	const slug = clubTemplateKeySlug(name);
	const taken = await tx
		.select({ key: meetingTemplates.key })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.clubId, clubId),
				isNull(meetingTemplates.meetingId),
				or(
					eq(meetingTemplates.key, slug),
					like(meetingTemplates.key, `${slug}-%`),
				),
			),
		);
	return firstFreeClubTemplateKey(slug, new Set(taken.map((r) => r.key)));
}

/**
 * Give every meeting that reads `templateId` DIRECTLY its own private copy of
 * it, and re-point the meeting there. After this, no meeting reads the row, so
 * its content can change without changing anybody's agenda.
 *
 * Only data from before private copies existed points a meeting at a shared
 * row (`meeting-agenda-edit-logic.ts`, `loadAgendaDraft`'s docblock), so this
 * is usually a no-op. The meetings are taken `FOR UPDATE`, the same lock
 * `ensureAgendaDraft` takes before it forks, so a concurrent first edit either
 * forked first (and the re-checked predicate no longer matches it) or waits
 * and then finds the copy made here.
 *
 * Copies through `copyTemplateForMeeting` under the MEETING's own club, so its
 * visibility gate still applies, then resolves the declared roles onto the
 * club's bank exactly as `ensureAgendaDraft`'s fork does. Returns the meeting
 * ids it re-pointed. Exported for #910.
 */
export async function forkLegacyPointers(
	tx: DbOrTx,
	templateId: string,
): Promise<string[]> {
	const pointing = await tx
		.select({ id: meetings.id, clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.templateId, templateId))
		.orderBy(asc(meetings.id))
		.for("update");
	for (const meeting of pointing) {
		const copyId = await copyTemplateForMeeting(tx, {
			sourceTemplateId: templateId,
			clubId: meeting.clubId,
			meetingId: meeting.id,
		});
		await materializeTemplateRoles(tx, meeting.clubId, copyId);
		await tx
			.update(meetings)
			.set({ templateId: copyId })
			.where(eq(meetings.id, meeting.id));
	}
	return pointing.map((m) => m.id);
}

export type SaveClubTemplateInput = {
	meetingId: string;
	clubId: string;
	actorMemberId: string | null;
} & (
	| { mode: "new"; name: string; description: string | null }
	| { mode: "replace"; templateId: string }
);

/**
 * Copy a meeting's CURRENT agenda into a club-owned template, new or replacing
 * one of the club's own. ONE transaction.
 *
 * The source is the meeting's own `template_id` — materialised first when the
 * meeting has never been opened in the editor, through the same path the
 * editor's load takes, so what is saved is exactly what the officer saw. A
 * cancelled meeting is refused; a completed one is a legitimate source.
 *
 * No meeting's agenda changes. A replace keeps the target's `id`, `key`,
 * `name`, `description`, `sort_order` and `enabled`, takes
 * `default_length_minutes` from the source, and swaps the content. Meetings
 * that applied the target earlier hold their own copies; the rare meeting
 * still pointing at the row itself is forked onto one first
 * (`forkLegacyPointers`).
 *
 * The replace target is resolved IN THE QUERY — `id`, `club_id` and
 * `meeting_id IS NULL` together — which is the tenant boundary: another club's
 * template, a global one and a private copy all read as absent.
 *
 * `clubId` and `actorMemberId` come from the server fn's gate, never from the
 * client. The meeting's own club is checked against `clubId` regardless.
 */
export async function saveMeetingAgendaAsClubTemplate(
	input: SaveClubTemplateInput,
): Promise<{ templateId: string }> {
	const { meetingId, clubId } = input;
	// Validated BEFORE the transaction opens, and folded into one
	// discriminated plan so the two arms below narrow on it with no
	// unreachable third branch.
	let plan:
		| { mode: "new"; fields: ClubTemplateFields }
		| { mode: "replace"; templateId: string };
	if (input.mode === "new") {
		const parsed = parseClubTemplateFields(input.name, input.description);
		if ("error" in parsed) throw new Error(parsed.error);
		plan = { mode: "new", fields: parsed };
	} else {
		plan = { mode: "replace", templateId: input.templateId };
	}

	return database.transaction(async (tx) => {
		// The CLUB row first, before anything else is read or written — and
		// the archive gate inside that same locked read (CODING_STANDARDS.md,
		// "gate INSIDE" a lock the write already holds).
		//
		// First because it has to be. Materialising a never-opened meeting
		// inserts a `meeting_templates` row, and that insert's foreign key
		// takes KEY SHARE on this club row. Taking the lock only afterwards (in
		// `nextClubTemplateKey`) meant two concurrent saves each held KEY SHARE
		// and each then waited for the other's to go: 40P01. Taken first, every
		// save in a club queues here instead.
		//
		// NO KEY UPDATE rather than UPDATE: it conflicts with itself, which is
		// the serialisation the key read needs, but NOT with the KEY SHARE any
		// other writer's foreign-key insert takes on this row — so an unrelated
		// edit elsewhere in the club never waits behind a save.
		const [club] = await tx
			.select({ archivedAt: clubs.archivedAt })
			.from(clubs)
			.where(eq(clubs.id, clubId))
			.for("no key update")
			.limit(1);
		if (!club) throw new Error("Club not found.");
		if (club.archivedAt !== null) throw new Error(CLUB_ARCHIVED_MESSAGE);

		// Then the meeting, locked: the same row `ensureAgendaDraft` and
		// conversion lock before touching its template, so a concurrent edit or
		// re-conversion lands wholly before or wholly after this save.
		const [meeting] = await tx
			.select({ clubId: meetings.clubId, status: meetings.status })
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.for("update")
			.limit(1);
		if (!meeting || meeting.clubId !== clubId) {
			throw new Error("Meeting not found.");
		}
		if (meeting.status === "cancelled") {
			throw new Error(
				"A cancelled meeting's agenda cannot be saved as a template.",
			);
		}
		const sourceTemplateId = await materialiseAgendaForMeeting(tx, meetingId);
		const [source] = await tx
			.select({ defaultLengthMinutes: meetingTemplates.defaultLengthMinutes })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, sourceTemplateId))
			.limit(1);
		// `meetings.template_id` is ON DELETE RESTRICT, so a live pointer's row
		// exists; this is the corrupt-pointer case only.
		if (!source) throw new Error("This meeting's agenda could not be read.");

		let templateId: string;
		if (plan.mode === "new") {
			const newFields = plan.fields;
			const key = await nextClubTemplateKey(tx, clubId, newFields.name);
			const [created] = await tx
				.insert(meetingTemplates)
				.values({
					clubId,
					meetingId: null,
					key,
					name: newFields.name,
					description: newFields.description,
					defaultLengthMinutes: source.defaultLengthMinutes,
					sortOrder: 0,
					enabled: true,
				})
				.onConflictDoNothing()
				.returning({ id: meetingTemplates.id });
			if (!created) throw new Error(CLUB_TEMPLATE_KEY_RACE_MESSAGE);
			templateId = created.id;
			await copyTemplateContent(tx, {
				fromTemplateId: sourceTemplateId,
				toTemplateId: templateId,
			});
		} else {
			const ownedTarget = and(
				eq(meetingTemplates.id, plan.templateId),
				eq(meetingTemplates.clubId, clubId),
				isNull(meetingTemplates.meetingId),
			);
			const [target] = await tx
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(ownedTarget)
				.limit(1);
			if (!target) throw new Error(CLUB_TEMPLATE_GONE_MESSAGE);
			templateId = target.id;

			// Old pointers FIRST, while the target still holds the content those
			// meetings are running. This includes the source meeting itself when
			// IT is one of them — `sourceTemplateId` was read above, so the swap
			// below still knows where the content came from.
			//
			// And BEFORE the target's FOR UPDATE below, which is lock ordering,
			// not style: `ensureAgendaDraft` locks a meeting and then (through
			// `copyTemplateContent`) takes FOR SHARE on the template it forks
			// from. Locking the target first and those meetings second is the
			// opposite order, and a first edit on a legacy meeting landing
			// mid-replace deadlocked against it.
			await forkLegacyPointers(tx, templateId);

			// Now the target, exclusively, before its content is swapped — the
			// lock every copier's FOR SHARE waits on (`copyTemplateContent`).
			// Club templates are never deleted and this club's saves serialise on
			// the club lock above, so the row read unlocked a moment ago is
			// still this club's; the predicate is repeated anyway.
			await tx
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(ownedTarget)
				.for("update");

			// A source that IS the target (old data: the meeting pointed straight
			// at the club template) has nothing to swap in — deleting the target's
			// content first would delete the source's too.
			if (sourceTemplateId !== templateId) {
				await tx
					.delete(meetingTemplateBeats)
					.where(eq(meetingTemplateBeats.templateId, templateId));
				await tx
					.delete(meetingTemplateRoles)
					.where(eq(meetingTemplateRoles.templateId, templateId));
				await copyTemplateContent(tx, {
					fromTemplateId: sourceTemplateId,
					toTemplateId: templateId,
				});
				await tx
					.update(meetingTemplates)
					.set({ defaultLengthMinutes: source.defaultLengthMinutes })
					.where(eq(meetingTemplates.id, templateId));
			}
		}

		// Inside the transaction, so the row commits with the save or not at all.
		await logActivity(tx, {
			clubId,
			actorMemberId: input.actorMemberId,
			action: "club_template_saved",
			targetType: "meeting",
			targetId: meetingId,
			detail: { templateId, mode: plan.mode, sourceMeetingId: meetingId },
		});

		return { templateId };
	});
}
