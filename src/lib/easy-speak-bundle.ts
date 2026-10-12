import { z } from "zod";

/**
 * The Easy-Speak export bundle, version 1 (#1047, part of the #1054 migration).
 *
 * The CANONICAL copy of the contract. The internal browser extension
 * (`extension/lib/easy-speak-bundle.ts`) walks an Easy-Speak club in the user's
 * own session and downloads one JSON file; the importer (#1054 child C) validates
 * the upload against this schema. The extension has no zod, so it keeps its own
 * TypeScript copy of the shape; `extension/lib/__fixtures__/easy-speak/
 * bundle.expected.json` is produced by the extension's parser tests and parsed
 * with this schema in `easy-speak-bundle.test.ts`, so the two cannot drift.
 *
 * Where the shape is looser than the maintainer's first sketch, the reason is on
 * the field. Every one of those is a thing the real pages do not give.
 */

/**
 * The two pages whose HTML carries phone numbers (`memberlist.php`,
 * `clubdata.php`). The extension never stores their HTML in `raw`; the importer
 * refuses a bundle that does. The same rule is `isContactPage` in
 * `extension/lib/easy-speak-bundle.ts`; the bundle test fails if they disagree.
 */
export function isContactPageUrl(url: string): boolean {
	return /(?:^|\/)(?:memberlist|clubdata)\.php(?:[?#/]|$)/i.test(url);
}

/** A person as Easy-Speak names them. `esUserId` is null when the page links no profile. */
export const esPersonRefSchema = z.object({
	esUserId: z.string().nullable(),
	name: z.string(),
});

/**
 * A timestamp the extension could place on the calendar. `Z` when the club's
 * IANA timezone was known; otherwise the club-local wall time with no offset.
 */
const instantSchema = z.iso.datetime({ offset: true, local: true });

/** `yyyy-mm-dd`, as Easy-Speak prints dates in its lists. */
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const roleSpeechSchema = z.object({
	/** Null on an agenda: the agenda page carries no speech id. Filled from the speech list when the speech can be matched. */
	esSpeechId: z.string().nullable(),
	/** Null when the speaker has not chosen one ("TBA"). */
	title: z.string().nullable(),
	/** The Pathways path, e.g. "Presentation Mastery". */
	path: z.string().nullable(),
	level: z.number().int().nullable(),
	/** The project's name without its "#level-n" prefix, e.g. "Evaluation and Feedback - 2". */
	project: z.string().nullable(),
	minMin: z.number().nullable(),
	maxMin: z.number().nullable(),
	/** Null except the exporter's own speeches when run by a member. */
	introduction: z.string().nullable(),
});

const roleSchema = z.object({
	/** Easy-Speak's label, verbatim: "Toastmaster", "1st Speaker", "Timer 2 - Online". */
	role: z.string(),
	/** 1-based position of the role in the meeting's role table. Unique within a meeting. */
	slot: z.number().int().min(1),
	/** Null for a vacant role. */
	holder: esPersonRefSchema.nullable(),
	speech: roleSpeechSchema.optional(),
	/** The `slot` of the speech this evaluator evaluates ("1st Evaluator" -> "1st Speaker"). */
	evaluates: z.number().int().min(1).optional(),
});

const attendanceSchema = z.object({
	who: esPersonRefSchema,
	/**
	 * What the person said they would do. Null on a past meeting, which shows the
	 * record instead. Easy-Speak's "Online" reply is "attending": the contract
	 * has no online plan; the raw page keeps the difference.
	 */
	plan: z
		.enum(["attending", "not_attending", "tentative", "unknown"])
		.nullable(),
	/**
	 * What was recorded after the meeting. Null on an upcoming meeting, and on a
	 * past one for a person recorded as "Did NOT Attend".
	 */
	record: z.enum(["attended", "attended_online"]).nullable(),
});

export const esGuestCategorySchema = z.enum([
	"guest_speaker",
	"visitor",
	"past_visitor",
	"visitor_other_club",
]);

const meetingSchema = z.object({
	esMeetingId: z.string(),
	startsAt: instantSchema,
	venue: z.string().nullable(),
	joinUrl: z.string().nullable(),
	theme: z.string().nullable(),
	/** Null for "Not Yet Chosen". */
	wordOfTheDay: z.string().nullable(),
	manager: z.string().nullable(),
	roles: z.array(roleSchema),
	/** Every person row on the meeting: members, past members and guests. */
	attendance: z.array(attendanceSchema),
	/**
	 * Guest-section rows with a signal: a reply other than "Unknown"/"NOT
	 * Attending", or a recorded attendance. The sections list every guest the
	 * club has ever known, so unfiltered they would be noise on every meeting.
	 */
	guests: z.array(
		z.object({ who: esPersonRefSchema, category: esGuestCategorySchema }),
	),
	awards: z.array(
		z.object({
			category: z.enum(["best_speaker", "best_evaluator", "best_table_topics"]),
			who: esPersonRefSchema,
		}),
	),
	/** `[]` when the club does not record them ("No speakers added yet"). */
	tableTopics: z.array(
		z.object({ who: esPersonRefSchema, topic: z.string().nullable() }),
	),
});

const speechRequestSchema = z.object({
	/** Null for a request with no assignment yet ("Undecided workbook"): Easy-Speak gives it no id. */
	esSpeechId: z.string().nullable(),
	who: esPersonRefSchema,
	title: z.string().nullable(),
	path: z.string().nullable(),
	project: z.string().nullable(),
	/** Null except the exporter's own speeches when run by a member. */
	introduction: z.string().nullable(),
	/** Null for a completed speech: the "Recent speeches" list carries no request date. */
	requestedOn: dateSchema.nullable(),
	/** The 1st, 2nd and 3rd preferred dates; null where none was given. */
	preferred: z.array(dateSchema.nullable()),
	/** The meeting date the speech is scheduled for, or was given on when completed. */
	scheduledOn: dateSchema.nullable(),
	/** "requested", "scheduled" or "completed". */
	status: z.string(),
});

export const easySpeakBundleV1Schema = z.object({
	format: z.literal("gavelup.easy-speak-bundle"),
	version: z.literal(1),
	exportedAt: z.iso.datetime({ offset: true }),
	/** The Easy-Speak username of whoever ran the export. */
	exportedBy: z.string(),
	club: z.object({
		esClubId: z.string(),
		number: z.string().nullable(),
		name: z.string(),
		timezone: z.string().nullable(),
	}),
	/** The member list's rows. Holds no phone number and no email. */
	people: z.array(
		z.object({
			esUserId: z.string(),
			name: z.string(),
			status: z.string(),
			joined: dateSchema.nullable(),
		}),
	),
	meetings: z.array(meetingSchema),
	speechRequests: z.array(speechRequestSchema),
	mentors: z.array(
		z.object({
			mentee: esPersonRefSchema,
			mentor: esPersonRefSchema.nullable(),
			wantsMentee: z.boolean(),
		}),
	),
	visitorsIntroduced: z.array(
		z.object({ visitor: esPersonRefSchema, introducedBy: esPersonRefSchema }),
	),
	/** Best-effort: `[]` is a valid bundle, and what a member export usually holds. */
	evaluations: z.array(
		z.object({
			esId: z.string(),
			speaker: esPersonRefSchema,
			evaluator: esPersonRefSchema,
			date: z.string(),
			text: z.string(),
		}),
	),
	/**
	 * Every page the walk fetched, as it came. Never `memberlist.php` or
	 * `clubdata.php`: their HTML carries phone numbers.
	 */
	raw: z.array(
		z
			.object({
				url: z.string(),
				fetchedAt: z.iso.datetime({ offset: true }),
				html: z.string(),
			})
			.refine((page) => !isContactPageUrl(page.url), {
				path: ["url"],
				message:
					"raw must not hold memberlist.php or clubdata.php: their HTML carries phone numbers",
			}),
	),
});

export type EsPersonRef = z.infer<typeof esPersonRefSchema>;
export type EasySpeakBundleV1 = z.infer<typeof easySpeakBundleV1Schema>;
