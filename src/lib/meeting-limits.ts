import { z } from "zod";
import { cap } from "./cap";
import { normalizePresentationUrl } from "./presentation-url";

/**
 * Length caps on the meeting free-text fields (#525).
 *
 * `theme` is the one that matters. It is unbounded on write and reachable with
 * NO SESSION: `updateMeeting` gates on `requireMeetingAgendaEditor`, whose
 * `tmod-self-assert` branch grants the write on a self-asserted `selfMemberId`
 * alone, with `sessionUserId` null — the same trust model as `claimSlot`. And
 * it renders into `minutes-pdf-logic.ts`, which lays out synchronously in the
 * single Node process (ADR-0007), so an oversized theme is the event loop —
 * and so the whole server — stopped.
 *
 * #522 capped `theme` at RENDER, which is what stops it reaching the renderer
 * today. This is the write half, and the half a render cap cannot do: it stops
 * the value being stored at all, which also bounds the agenda and minutes JSON
 * payloads and every non-PDF surface that reads the column.
 *
 * `location`, `notes` and `reminders` are capped alongside it. They sit on the
 * SAME two schemas, reached through the SAME no-session path, and none of them
 * had a bound either. None reaches a server-rendered PDF — checked, not
 * assumed — so they are storage and bandwidth rather than CPU. Capping them
 * costs one line each; leaving three of five unbounded in a file being edited
 * for exactly this is how #522 ended up half-done and needing a second pass.
 *
 * `topic` (Table Topics) is here for the same reason, but note it is
 * ADMIN-ONLY (`addTableTopics` → `gateAdmin`), not no-session. It renders into
 * the same minutes PDF.
 *
 * One asymmetry worth knowing before treating these as uniform:
 * `createMeetingSchema` does not accept `reminders` at all (announcements are
 * set through the edit paths), so `MEETING_FIELDS.reminders` is tested but
 * composed nowhere. It is kept for symmetry with `MEETING_UPDATE_FIELDS` —
 * the same caveat [[wod-limits]] already makes about its own `definition` and
 * `example` on the create side.
 *
 * Sized well above anything real. Longest on record: `theme` 20 characters,
 * `location` 30, `reminders` 62, `notes` and `topic` empty.
 */
export const MEETING_LIMITS = {
	/** Meeting theme. Renders into the minutes PDF; writable with no session. */
	theme: 200,
	/** Where the club meets. A line, not a paragraph. */
	location: 200,
	/** Free-text meeting notes. Sized for prose. */
	notes: 2_000,
	/**
	 * The announcements field (#349 reuses `meetings.reminders` for it), which
	 * is read aloud and printed, so it is genuinely multi-line.
	 */
	reminders: 2_000,
	/** A Table Topics question. Renders into the minutes PDF. */
	topic: 200,
	/**
	 * The video-call join link (#731). Measured against the NORMALIZED value —
	 * see `JOIN_URL_FIELD`. Generous: the longest real join link on record is a
	 * Teams URL at ~450 characters, and Zoom's are ~70.
	 */
	joinUrl: 2_048,
} as const;

/**
 * A rejecting validator with a human message.
 *
 * The message matters as much as the cap: `ZodError.message` is
 * `JSON.stringify(issues)`, and the meeting form renders it straight into a
 * toast. Adding `.max()` without one would put a raw multi-line JSON dump in
 * front of a club officer — the same trap #522 hit on the claim sheet.
 */
const rejecting = (max: number, label: string) =>
	z.string().trim().max(max, `Keep the ${label} under ${max} characters.`);

/** Truncating, through the audited `cap` — never a bare `.slice()`, which cuts
 *  surrogate pairs in half and stores a lone surrogate that Postgres encodes to
 *  U+FFFD. That defect shipped twice before it was found (#519, #522). */
const truncating = (max: number) =>
	z
		.string()
		.trim()
		.transform((v) => cap(v, max));

/**
 * The CREATE-path validators, which REJECT.
 *
 * `createMeetingSchema` is a fresh form with nothing prefilled, so an error
 * costs only the field being typed and is actionable.
 */
export const MEETING_FIELDS = {
	theme: rejecting(MEETING_LIMITS.theme, "theme"),
	location: rejecting(MEETING_LIMITS.location, "location"),
	notes: rejecting(MEETING_LIMITS.notes, "notes"),
	reminders: rejecting(MEETING_LIMITS.reminders, "announcements"),
	topic: rejecting(MEETING_LIMITS.topic, "topic"),
} as const;

/**
 * The UPDATE-path validators, which TRUNCATE.
 *
 * `updateMeetingSchema` covers the WHOLE meeting — date, location, theme,
 * notes, announcements and the Word of the Day together — and the form prefills
 * and resubmits all of it. A single value stored before these caps existed
 * would otherwise fail `.parse()` and block saving the meeting's DATE, with no
 * way to repair the offending field except through the form it blocks.
 *
 * This is the same split, for the same reason, that the same schema already
 * applies to the Word of the Day via [[wod-limits]] — `updateMeetingSchema`
 * composes `WOD_UPDATE_FIELDS` while `createMeetingSchema` composes
 * `WOD_FIELDS`. These sit directly beside them.
 *
 * `topic` is here too, and the reason is stronger than the others rather than
 * weaker. `addTableTopics` creates one row and prefills nothing, so on the face
 * of it rejecting costs only the field being typed. But that op is QUEUED when
 * minutes are taken offline, and `drainMinutesQueue` stops at the FIRST failing
 * op and returns it plus every successor as still-queued
 * (`drain-minutes.ts:216`), while the auto-drain effect then bails for as long
 * as `syncError` is set. There is no UI to drop the offending op. So a single
 * over-long topic typed offline would freeze attendance, guests, awards and
 * every later minutes write for that meeting, permanently.
 *
 * That is the reject/truncate rule pointing the other way: the failure does not
 * cost the field, it costs the queue. Before this change `topic` had no
 * `.max()` at all, so a ZodError was unreachable from that form — adding one
 * without this would have INTRODUCED the lockout, not closed it.
 */
export const MEETING_UPDATE_FIELDS = {
	theme: truncating(MEETING_LIMITS.theme),
	location: truncating(MEETING_LIMITS.location),
	notes: truncating(MEETING_LIMITS.notes),
	reminders: truncating(MEETING_LIMITS.reminders),
	topic: truncating(MEETING_LIMITS.topic),
} as const;

/**
 * The video-call join link (#731). ONE validator for both the create and the
 * update schema, and it measures the **normalized** value.
 *
 * ## Why not `z.string().max(2048)` on the input
 *
 * That was the first cut and it was wrong in a way that reads as correct. The
 * stored value is not the input: `applyMeetingUpdate` writes
 * `normalizePresentationUrl(input.joinUrl)`, and normalization GROWS the string
 * — percent-encoding is up to 6x (measured: `https://zoom.us/j/` + "é"×1000 is
 * 1018 characters in and **6018** stored), and a bare host gains `https://`.
 *
 * So an input cap admits values the column cannot round-trip, and that is a
 * LOCKOUT, not a cosmetic gap. `updateMeetingSchema` covers the whole meeting;
 * the edit dialog resends the stored link on every save and `themeOnlyUpdate`
 * echoes it, so once an over-long value is stored the meeting's date, theme,
 * Word of the Day and notes all stop being savable. `/me/theme` has no join-link
 * input at all, so a TMOD is hard-blocked with no way to repair it — and the
 * write is reachable through the session-less `tmod-self-assert` arm, so it is
 * an unauthenticated denial of service on one meeting record.
 *
 * Measuring the normalized value closes it for good, because normalization is
 * idempotent (asserted in the test beside this file): a value that passed once
 * re-normalizes to itself and passes forever.
 *
 * ## Neither rejecting nor truncating, exactly
 *
 * It REJECTS, unlike `MEETING_UPDATE_FIELDS`, and the lockout argument that
 * drives truncation elsewhere does not apply: the column ships in #731's own
 * migration, so no pre-cap value can exist, and every value that ever reaches it
 * has passed this check. Truncating would be actively worse — a shortened URL is
 * a broken link, not a shorter one, and it would be stored looking fine.
 *
 * The raw length is checked FIRST so an 8MB paste is refused before it reaches
 * the URL parser, then the normalized length, which is the one that gets stored.
 */
export const JOIN_URL_FIELD = z.string().superRefine((raw, ctx) => {
	const trimmed = raw.trim();
	const tooLong =
		trimmed.length > MEETING_LIMITS.joinUrl ||
		(normalizePresentationUrl(trimmed)?.length ?? 0) > MEETING_LIMITS.joinUrl;
	if (!tooLong) return;
	ctx.addIssue({
		code: "custom",
		// Same shape as `rejecting`'s message, and for the same reason: this text
		// goes straight into a toast in front of a club officer.
		message: `Keep the video call link under ${MEETING_LIMITS.joinUrl} characters.`,
	});
});
