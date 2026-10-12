/**
 * The Easy-Speak export bundle, version 1 (#1047), and the one function that
 * assembles it from what the page parsers return.
 *
 * The canonical contract is the zod schema in `src/lib/easy-speak-bundle.ts`
 * (the importer validates against it). The extension has no zod, so this file
 * keeps a plain TypeScript copy of the shape. They are held together by
 * `__fixtures__/easy-speak/bundle.expected.json`: the parser tests here produce
 * it, and `src/lib/easy-speak-bundle.test.ts` parses that file with the schema.
 */

import { norm } from "./easy-speak-text";

export interface EsPersonRef {
	esUserId: string | null;
	name: string;
}

export type EsGuestCategory =
	| "guest_speaker"
	| "visitor"
	| "past_visitor"
	| "visitor_other_club";

export interface EsRoleSpeech {
	esSpeechId: string | null;
	title: string | null;
	path: string | null;
	level: number | null;
	project: string | null;
	minMin: number | null;
	maxMin: number | null;
	introduction: string | null;
}

export interface EsRole {
	role: string;
	slot: number;
	holder: EsPersonRef | null;
	speech?: EsRoleSpeech;
	evaluates?: number;
}

export interface EsAttendance {
	who: EsPersonRef;
	plan: "attending" | "not_attending" | "tentative" | "unknown" | null;
	record: "attended" | "attended_online" | null;
}

export interface EsMeeting {
	esMeetingId: string;
	startsAt: string;
	venue: string | null;
	joinUrl: string | null;
	theme: string | null;
	wordOfTheDay: string | null;
	manager: string | null;
	roles: EsRole[];
	attendance: EsAttendance[];
	guests: { who: EsPersonRef; category: EsGuestCategory }[];
	awards: {
		category: "best_speaker" | "best_evaluator" | "best_table_topics";
		who: EsPersonRef;
	}[];
	tableTopics: { who: EsPersonRef; topic: string | null }[];
}

export interface EsSpeechRequest {
	esSpeechId: string | null;
	who: EsPersonRef;
	title: string | null;
	path: string | null;
	project: string | null;
	introduction: string | null;
	requestedOn: string | null;
	preferred: (string | null)[];
	scheduledOn: string | null;
	status: string;
}

export interface EsPerson {
	esUserId: string;
	name: string;
	status: string;
	joined: string | null;
}

export interface EsMentor {
	mentee: EsPersonRef;
	mentor: EsPersonRef | null;
	wantsMentee: boolean;
}

export interface EsEvaluation {
	esId: string;
	speaker: EsPersonRef;
	evaluator: EsPersonRef;
	date: string;
	text: string;
}

export interface EsRawPage {
	url: string;
	fetchedAt: string;
	html: string;
}

export interface EasySpeakBundleV1 {
	format: "gavelup.easy-speak-bundle";
	version: 1;
	exportedAt: string;
	exportedBy: string;
	club: {
		esClubId: string;
		number: string | null;
		name: string;
		timezone: string | null;
	};
	people: EsPerson[];
	meetings: EsMeeting[];
	speechRequests: EsSpeechRequest[];
	mentors: EsMentor[];
	visitorsIntroduced: { visitor: EsPersonRef; introducedBy: EsPersonRef }[];
	evaluations: EsEvaluation[];
	raw: EsRawPage[];
}

/**
 * A speech-list row, plus the two things only the assembler needs: which
 * meeting it is scheduled for (or completed at), and where the viewer may read
 * its request form. Neither is part of the bundle.
 */
export interface ParsedSpeechRow {
	request: EsSpeechRequest;
	meetingId: string | null;
	requestFormPath: string | null;
}

export interface RequestFormInfo {
	esSpeechId: string | null;
	title: string | null;
	introduction: string | null;
}

export interface AssembleInput {
	exportedAt: string;
	exportedBy: string;
	club: EasySpeakBundleV1["club"];
	people: EsPerson[];
	/** `esUserId` -> joined date, from the mentors chart. */
	joined: Map<string, string>;
	meetings: EsMeeting[];
	speechRows: ParsedSpeechRow[];
	/** Request forms by speech id. */
	requestForms: Map<string, RequestFormInfo>;
	mentors: EsMentor[];
	visitorsIntroduced: EasySpeakBundleV1["visitorsIntroduced"];
	evaluations: EsEvaluation[];
	raw: EsRawPage[];
}

/**
 * The two pages whose HTML carries phone numbers. They are parsed and never
 * stored in `raw`. The same rule, character for character, is `isContactPageUrl`
 * in `src/lib/easy-speak-bundle.ts` (which the importer validates `raw` with);
 * `src/lib/easy-speak-bundle.test.ts` fails if the two ever disagree.
 */
export function isContactPage(url: string): boolean {
	return /(?:^|\/)(?:memberlist|clubdata)\.php(?:[?#/]|$)/i.test(url);
}

/**
 * Match each agenda speech to its speech-list row: same holder, same meeting
 * (the row's scheduled or completed date links the meeting). That gives the
 * agenda speech the Easy-Speak speech id the agenda itself never shows, and, for
 * the exporter's own speeches, the introduction from the request form.
 */
function linkSpeeches(
	meetings: EsMeeting[],
	rows: ParsedSpeechRow[],
	forms: Map<string, RequestFormInfo>,
): EsMeeting[] {
	const used = new Set<ParsedSpeechRow>();
	return meetings.map((m) => ({
		...m,
		roles: m.roles.map((r) => {
			if (!r.speech || !r.holder?.esUserId) return r;
			const holderId = r.holder.esUserId;
			const candidates = rows.filter(
				(row) =>
					!used.has(row) &&
					row.meetingId === m.esMeetingId &&
					row.request.who.esUserId === holderId &&
					row.request.esSpeechId !== null,
			);
			const sameProject = candidates.find(
				(row) =>
					row.request.project !== null &&
					row.request.project === r.speech?.project,
			);
			const hit = sameProject ?? candidates[0];
			if (!hit) return r;
			used.add(hit);
			const id = hit.request.esSpeechId;
			const intro = id ? (forms.get(id)?.introduction ?? null) : null;
			return {
				...r,
				speech: {
					...r.speech,
					esSpeechId: id,
					introduction: intro ?? r.speech.introduction,
				},
			};
		}),
	}));
}

export function assembleBundle(input: AssembleInput): EasySpeakBundleV1 {
	const meetings = linkSpeeches(
		[...input.meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
		input.speechRows,
		input.requestForms,
	);
	return {
		format: "gavelup.easy-speak-bundle",
		version: 1,
		exportedAt: input.exportedAt,
		exportedBy: input.exportedBy,
		club: input.club,
		people: input.people.map((p) => ({
			...p,
			joined: p.joined ?? input.joined.get(p.esUserId) ?? null,
		})),
		meetings,
		speechRequests: input.speechRows.map((row) => {
			const id = row.request.esSpeechId;
			const form = id ? input.requestForms.get(id) : undefined;
			return {
				...row.request,
				title: row.request.title ?? form?.title ?? null,
				introduction: form?.introduction ?? row.request.introduction,
			};
		}),
		mentors: input.mentors,
		visitorsIntroduced: input.visitorsIntroduced,
		evaluations: input.evaluations,
		raw: input.raw,
	};
}

/** `easy-speak-<clubNumber>-<yyyy-mm-dd>.json`; the Easy-Speak club id stands in for a club with no number. */
export function bundleFileName(b: EasySpeakBundleV1): string {
	const who = norm(b.club.number ?? b.club.esClubId).replace(/[^\w-]+/g, "-");
	return `easy-speak-${who}-${b.exportedAt.slice(0, 10)}.json`;
}
