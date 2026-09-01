// Club identifier resolution. Lives away from the createServerFn wrapper
// (`clubs.ts`, client-imported) so its `db` import is never bundled into the
// client. See the header of `members-logic.ts`.
import { eq, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs } from "#/db/schema";
import { isClubArchived } from "#/lib/club-archive";
import {
	CLUB_TIMEZONES,
	DEFAULT_CLUB_TIMEZONE,
	INVALID_TIMEZONE_MESSAGE,
	isSupportedClubTimezone,
} from "#/lib/club-timezone";
import { DEFAULT_COUNTRY_CODE } from "#/lib/phone";
import { isReadableClub } from "./club-readable-logic";

/**
 * The country code to normalize this club's phone numbers with (#295) — the
 * club's own setting, or `DEFAULT_COUNTRY_CODE` when it hasn't set one.
 *
 * NEVER null (#397). This is the ONE seam every phone write and every read-time
 * coalescer goes through, so returning null here is what let a bare national
 * number be stored as typed while the same number typed with `+1` was stored as
 * E.164 — one phone, two dedup keys, two guest rows. Defaulting here fixes every
 * call site at once instead of asking each one to remember.
 *
 * The stored NULL is preserved (this doesn't write the default back to the club
 * row): "never told us" stays distinguishable from "chose +1", so a later
 * onboarding question or timezone-based inference can still fill it in.
 */
export async function loadClubDefaultCountryCode(
	clubId: string,
): Promise<string> {
	const [row] = await db
		.select({ cc: clubs.defaultCountryCode })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row?.cc?.trim() || DEFAULT_COUNTRY_CODE;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvedClub = {
	id: string;
	slug: string;
	name: string;
	timezone: string;
	clubNumber: string | null;
	archivedAt: Date | null;
};

/**
 * Resolve a URL segment to a club by slug (case-insensitive), then club number,
 * then UUID. Returns null if nothing matches. Slug is tried first, so a slug
 * that happens to equal a club number still wins as a slug.
 */
export async function resolveClubByIdentifier(
	identifier: string,
): Promise<ResolvedClub | null> {
	const seg = identifier.trim();
	const lower = seg.toLowerCase();

	// Build match conditions. Only compare against `id` when the segment is a
	// real UUID — otherwise Postgres throws "invalid input syntax for type uuid".
	const conds: SQL[] = [eq(clubs.slug, lower), eq(clubs.clubNumber, seg)];
	if (UUID_RE.test(seg)) conds.push(eq(clubs.id, seg));

	const rows = await db
		.select({
			id: clubs.id,
			slug: clubs.slug,
			name: clubs.name,
			timezone: clubs.timezone,
			clubNumber: clubs.clubNumber,
			archivedAt: clubs.archivedAt,
		})
		.from(clubs)
		.where(or(...conds));

	if (rows.length === 0) return null;
	// Precedence: slug > club number > id.
	return (
		rows.find((r) => r.slug === lower) ??
		rows.find((r) => r.clubNumber === seg) ??
		rows[0]
	);
}

/**
 * PUBLIC identifier resolution — {@link resolveClubByIdentifier} with archived
 * rows redacted to null (#544).
 *
 * `resolveClubByIdentifier` itself MUST keep returning them: `resolveClubOrRedirect`
 * reads `archivedAt` off the row to decide its own 404, and
 * `archive-club.integration.test.ts` pins that. But the server fn wrapping it is
 * a public GET, and returning the row there hands an anonymous caller the club's
 * NAME and Toastmasters CLUB NUMBER after a takedown — for a lever whose stated
 * purpose (ADR-0024) is removing exactly that brand identity. It was also the
 * first link in an attack chain the adversarial review traced end to end: slug →
 * club UUID + name here → meeting UUIDs → the full agenda.
 *
 * Redacting is behaviour-preserving for both callers. `resolveClubOrRedirect`
 * already collapses null and archived to the same `notFound()`
 * (`if (!club || isClubArchived(club))`), and the VP-membership loader reads
 * `resolved?.slug ?? null`.
 */
export async function resolvePublicClubIdentifier(
	identifier: string,
): Promise<ResolvedClub | null> {
	const club = await resolveClubByIdentifier(identifier);
	return club && isClubArchived(club) ? null : club;
}

// ---------------------------------------------------------------------------
// Club profile (district / mission / meeting schedule) — printable-agenda fields.
// ---------------------------------------------------------------------------

export type ClubProfile = {
	name: string;
	district: string | null;
	mission: string | null;
	meetingSchedule: string | null;
	defaultCountryCode: string | null;
};

/** The free-text profile fields for the club-settings form. Null if unset. */
export async function getClubProfile(
	clubId: string,
): Promise<ClubProfile | null> {
	const [row] = await db
		.select({
			name: clubs.name,
			district: clubs.district,
			mission: clubs.mission,
			meetingSchedule: clubs.meetingSchedule,
			defaultCountryCode: clubs.defaultCountryCode,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row ?? null;
}

/** The subset of the club profile shown to ANONYMOUS visitors on the public
 *  club page (#318) — what the club is and when it meets. */
export type PublicClubProfile = {
	district: string | null;
	mission: string | null;
	meetingSchedule: string | null;
};

/**
 * The club's public-facing profile. PUBLIC — no session, so the column list is
 * deliberately narrow and spelled out rather than reusing `getClubProfile`.
 *
 * `getClubProfile` also returns `defaultCountryCode`, which is internal dialing
 * config for the WhatsApp nudge links (#295) and has no business on an
 * unauthenticated payload. Adding a column to `clubs` must not silently widen
 * what an anonymous visitor can read, so this query names its three columns and
 * nothing else. The public club surfaces are a SOFT gate — never put anything
 * member-identifying on their payload.
 *
 * All three fields are already normalized on write (`emptyToNull` below), so a
 * stored value is either null or non-blank; callers still guard on whitespace
 * for rows that predate that normalization.
 *
 * ARCHIVED CLUBS RETURN NULL (#544). The `/club/$clubId` shell 404s an archived
 * club in `beforeLoad`, but that guards the CALLER: this is reachable as a bare
 * `createServerFn` endpoint with no session, and the club UUID it needs is
 * itself anonymously obtainable from `resolveClubByIdentifier`. `mission` is
 * club-authored free text and archiving is the takedown lever (ADR-0016 /
 * ADR-0024), so serving it here defeats the mechanism.
 */
export async function getPublicClubProfile(
	clubId: string,
): Promise<PublicClubProfile | null> {
	if (!(await isReadableClub(clubId))) return null;
	const [row] = await db
		.select({
			district: clubs.district,
			mission: clubs.mission,
			meetingSchedule: clubs.meetingSchedule,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row ?? null;
}

// Empty strings collapse to null so cleared fields disappear from the agenda
// (no empty labels/artifacts) rather than persisting a blank value.
const emptyToNull = z
	.string()
	.trim()
	.transform((s) => (s.length === 0 ? null : s))
	.nullable()
	.optional();

// Default international dialing code (#295). Normalized to `+<digits>` (or null)
// so member/guest phone numbers lacking a country code can be coalesced to a
// valid WhatsApp number.
const countryCode = z
	.string()
	.trim()
	.transform((s) => {
		const digits = s.replace(/\D/g, "");
		return digits === "" ? null : `+${digits}`;
	})
	.nullable()
	.optional();

export const clubProfileSchema = z.object({
	clubId: z.string().uuid(),
	district: emptyToNull,
	mission: emptyToNull,
	meetingSchedule: emptyToNull,
	defaultCountryCode: countryCode,
});
export type ClubProfileInput = z.infer<typeof clubProfileSchema>;

/** Set/clear the club's district, mission, and meeting schedule. Caller is
 *  responsible for the admin authorization check (see `updateClubProfile`). */
export async function applyClubProfileUpdate(input: ClubProfileInput) {
	const [updated] = await db
		.update(clubs)
		.set({
			district: input.district ?? null,
			mission: input.mission ?? null,
			meetingSchedule: input.meetingSchedule ?? null,
			defaultCountryCode: input.defaultCountryCode ?? null,
		})
		.where(eq(clubs.id, input.clubId))
		.returning({ id: clubs.id });
	if (!updated) throw new Error("Club not found.");
	return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Agenda settings — the club's run-of-show variant (#367).
// ---------------------------------------------------------------------------

/** The one axis of per-club variance in the generated run-of-show. Kept as an
 *  object (rather than a bare boolean) because it is the config `buildRunOfShow`
 *  and `buildSlideDeck` take, and because it is the natural home for any second
 *  agenda knob. */
export type ClubAgendaSettings = { geIntroducesFunctionaries: boolean };

/** The standard Toastmasters flow — what a club gets unless it says otherwise.
 *  Mirrors the column default in `schema.ts`. */
export const DEFAULT_CLUB_AGENDA_SETTINGS: ClubAgendaSettings = {
	geIntroducesFunctionaries: false,
};

/** Read a club's agenda settings. Falls back to the standard flow when the club
 *  row is somehow missing (never throws), so a renderer can always render. */
export async function getClubAgendaSettings(
	clubId: string,
): Promise<ClubAgendaSettings> {
	const [row] = await db
		.select({ geIntroducesFunctionaries: clubs.geIntroducesFunctionaries })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row ?? DEFAULT_CLUB_AGENDA_SETTINGS;
}

export const clubAgendaSettingsSchema = z.object({
	clubId: z.string().uuid(),
	geIntroducesFunctionaries: z.boolean(),
});
export type ClubAgendaSettingsInput = z.infer<typeof clubAgendaSettingsSchema>;

/** Persist a club's agenda settings. Caller enforces admin authz (see the
 *  `updateClubAgendaSettings` wrapper). */
export async function applyClubAgendaSettingsUpdate(
	input: ClubAgendaSettingsInput,
): Promise<{ ok: true }> {
	const [updated] = await db
		.update(clubs)
		.set({ geIntroducesFunctionaries: input.geIntroducesFunctionaries })
		.where(eq(clubs.id, input.clubId))
		.returning({ id: clubs.id });
	if (!updated) throw new Error("Club not found.");
	return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Time zone — the club-local axis everything else is measured against (#547).
// ---------------------------------------------------------------------------

export type ClubTimezoneSettings = {
	timezone: string;
	/** The picker's options. See `CLUB_TIMEZONES` for why the SERVER's list. */
	zones: readonly string[];
};

/**
 * A club's timezone plus the list it may be set to.
 *
 * Falls back to {@link DEFAULT_CLUB_TIMEZONE} when the club row is missing
 * (never throws), mirroring `getClubAgendaSettings` — a settings form can always
 * render, and the value it shows is the one the column default would have given.
 *
 * **The stored zone is unioned in when the list no longer contains it.**
 * `CLUB_TIMEZONES` is computed from the RUNNING process's ICU tables, and those
 * change between deploys: a zone written under one Node build can be spelled
 * differently — or dropped — under the next. Without this the select would hold
 * no `<option>` matching `value={zone}`, which does not error; it silently
 * displays the FIRST option, so a club in Asia/Calcutta would read as
 * Africa/Abidjan and the next save would write that. Same failure the header of
 * `club-timezone.ts` describes for browser-vs-server, one axis over, and the
 * reason the write-time `.refine` alone is not enough: it only proves the value
 * was valid when it was written.
 */
export async function getClubTimezoneSettings(
	clubId: string,
): Promise<ClubTimezoneSettings> {
	const [row] = await db
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	const timezone = row?.timezone ?? DEFAULT_CLUB_TIMEZONE;
	return {
		timezone,
		zones: isSupportedClubTimezone(timezone)
			? CLUB_TIMEZONES
			: [timezone, ...CLUB_TIMEZONES].sort(),
	};
}

/**
 * Validation is here, in the schema the server fn parses with, rather than only
 * in the picker: the server fn is addressable directly with no form and no
 * session-bearing client, so a client-side `<select>` constrains nobody.
 */
export const clubTimezoneSchema = z.object({
	clubId: z.string().uuid(),
	timezone: z.string().refine(isSupportedClubTimezone, {
		message: INVALID_TIMEZONE_MESSAGE,
	}),
});
export type ClubTimezoneInput = z.infer<typeof clubTimezoneSchema>;

/**
 * Persist a club's timezone. Caller enforces admin authz (see the
 * `updateClubTimezone` wrapper), which is also what carries the archive gate:
 * `requireClubRole` → `requireMembership` → `assertNotArchived`, the same cover
 * the two sibling settings writers above rely on.
 *
 * **This re-labels meetings that already exist.** Stored `scheduled_at` instants
 * do not move, but every club-local rendering of them is derived from this
 * column at read time — including the URL date key, which is not stored
 * anywhere (`meetingUrlKey` / `resolveMeetingKey`). So a meeting whose link was
 * shared before the change can answer not-found afterwards, and on a
 * double-header day a bare-date key can even resolve to the OTHER meeting. That
 * is the accepted behaviour rather than an oversight: pinning old keys would
 * mean storing one, and a club whose zone was wrong wants its dates corrected,
 * which is the whole point of the setting. The uuid form of the key is stable
 * across the change and is what a durable link should use.
 * `club-timezone.integration.test.ts` pins all three halves of that.
 */
export async function applyClubTimezoneUpdate(
	input: ClubTimezoneInput,
): Promise<{ ok: true }> {
	const [updated] = await db
		.update(clubs)
		.set({ timezone: input.timezone })
		.where(eq(clubs.id, input.clubId))
		.returning({ id: clubs.id });
	if (!updated) throw new Error("Club not found.");
	return { ok: true as const };
}
