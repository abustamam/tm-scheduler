/**
 * #1396: every link the app builds to a meeting page or sub-page names the
 * meeting by its canonical URL key, never its uuid. The uuid is a row id, and a
 * link built from it is the one form that is not the date the club talks about
 * and not the form a printed or shared link has.
 *
 * What it reads: any `/club/$clubId…/meeting/$meetingId…` route link whose
 * `meetingId` param is a meeting's `.id` / `.meetingId`, and any built
 * `/meeting/${x.id}` path. A bare identifier (`meetingKey`, `urlKey`) passes: it
 * is a key by name, and the typed fixtures hold the rest. The read is RAW, not
 * comment-blind: this is an offender-list guard, where stripping could only hide
 * one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");
const LINK_FLOOR = 28;
const PATH_FLOOR = 11;
const SINK_FLOOR = 30;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

// `params.meetingId` is the URL segment, already a key; any other `.meetingId`
// is a row's uuid column.
const UUID_VALUE = /(?:\.id|(?<!\bparams)\.meetingId)\b/;
// A route link: the route string, then (within reach) a `params={{ … }}` JSX
// attribute or a `params: { … }` object property, as `navigate`/`redirect` take.
const ROUTE_LINK =
	/\/club\/\$clubId_?\/meeting\/\$meetingId[\w./$]*["'`][\s\S]{0,400}?params(?:=\{\{|:\s*\{)([^}]*)\}/g;
const BUILT_PATH = /\/meeting\/\$\{([^}]*)\}/g;
// `<MeetingLink meetingKey={x.id}>` and `{ meetingKey: x.id }`.
const KEY_PROP = /\bmeetingKey(?:=\{|:\s*)([^,}\n]+)/g;
// Builders whose meeting argument is a key: name -> 0-based argument index.
const KEY_BUILDERS: Record<string, number> = {
	cancellationNoticeHref: 1,
	buildAgendaSharePath: 1,
};
// A local that holds a meeting's uuid: `const meetingId = m.id`, or
// `{ id: meetingId }` destructured out of a meeting. Names a bare `meetingId`
// shorthand in params as a uuid.
const UUID_LOCAL =
	/(?:(?:const|let)\s+meetingId\s*=\s*[^;\n]*(?:\.id|\.meetingId)\b|\bid:\s*meetingId\b)/;

/** A deliberate uuid in a meeting URL: `file: snippet`. Empty today. */
const ALLOWED_UUID_LINKS: string[] = [];

type Inspected = { links: number; paths: number; sinks: number };

function topLevelArgs(src: string, open: number): string[] {
	const args: string[] = [];
	let depth = 0;
	let cur = "";
	for (let i = open + 1; i < src.length; i++) {
		const c = src[i];
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) {
			if (depth === 0) break;
			depth--;
		}
		if (c === "," && depth === 0) {
			args.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	if (cur.trim()) args.push(cur.trim());
	return args;
}

function uuidMeetingLinks(
	source: string,
	seen: Inspected = { links: 0, paths: 0, sinks: 0 },
): string[] {
	const found: string[] = [];
	for (const m of source.matchAll(ROUTE_LINK)) {
		seen.links++;
		const body = m[1] ?? "";
		const value = body.match(/meetingId:\s*([^,}]+)/)?.[1]?.trim();
		if (value) {
			if (UUID_VALUE.test(value)) found.push(`meetingId: ${value}`);
		} else if (/\bmeetingId\b/.test(body) && UUID_LOCAL.test(source)) {
			found.push("meetingId (shorthand, a uuid local)");
		}
	}
	for (const m of source.matchAll(BUILT_PATH)) {
		seen.paths++;
		if (UUID_VALUE.test(m[1])) found.push(`/meeting/\${${m[1]}}`);
	}
	for (const m of source.matchAll(KEY_PROP)) {
		seen.sinks++;
		if (UUID_VALUE.test(m[1])) found.push(`meetingKey: ${m[1].trim()}`);
	}
	for (const [name, index] of Object.entries(KEY_BUILDERS)) {
		for (const m of source.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
			seen.sinks++;
			const arg = topLevelArgs(source, (m.index ?? 0) + m[0].length - 1)[index];
			if (arg && UUID_VALUE.test(arg)) found.push(`${name}(…, ${arg})`);
		}
	}
	return found;
}

describe("meeting links use the canonical key (#1396)", () => {
	it("flags a route link and a built path made from a meeting's id", () => {
		expect(
			uuidMeetingLinks(
				'<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId: m.id }}>',
			),
		).toEqual(["meetingId: m.id"]);
		expect(
			uuidMeetingLinks("`/club/${slug}/meeting/${meeting.id}/print`"),
		).toEqual(["/meeting/${meeting.id}"]);
		expect(
			uuidMeetingLinks(
				'<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId: m.urlKey }}>',
			),
		).toEqual([]);
	});

	it("flags the object form, the shorthand over a uuid local, and the named sinks", () => {
		expect(
			uuidMeetingLinks(
				'navigate({ to: "/club/$clubId/meeting/$meetingId", params: { clubId, meetingId: m.id } })',
			),
		).toEqual(["meetingId: m.id"]);
		expect(
			uuidMeetingLinks(
				'const meetingId = m.id;\n<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId }}>',
			),
		).toEqual(["meetingId (shorthand, a uuid local)"]);
		expect(
			uuidMeetingLinks(
				'const { id: meetingId } = meeting;\n<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId }}>',
			),
		).toEqual(["meetingId (shorthand, a uuid local)"]);
		expect(
			uuidMeetingLinks(
				'const { meetingId } = Route.useParams();\n<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId }}>',
			),
		).toEqual([]);
		expect(uuidMeetingLinks("<MeetingLink meetingKey={x.id} />")).toEqual([
			"meetingKey: x.id",
		]);
		expect(uuidMeetingLinks("f({ meetingKey: x.meetingId })")).toEqual([
			"meetingKey: x.meetingId",
		]);
		expect(uuidMeetingLinks("f({ meetingKey: params.meetingId })")).toEqual([]);
		expect(uuidMeetingLinks("cancellationNoticeHref(c, x.id)")).toEqual([
			"cancellationNoticeHref(…, x.id)",
		]);
		expect(uuidMeetingLinks("buildAgendaSharePath(c, x.id, layout)")).toEqual([
			"buildAgendaSharePath(…, x.id)",
		]);
		expect(
			uuidMeetingLinks("buildAgendaSharePath(c, x.urlKey, layout.id)"),
		).toEqual([]);
	});

	it("no source file builds a meeting link from a meeting's uuid", () => {
		const seen: Inspected = { links: 0, paths: 0, sinks: 0 };
		const offenders = sourceFiles(SRC)
			.flatMap((file) =>
				uuidMeetingLinks(readFileSync(file, "utf8"), seen).map(
					(hit) => `${relative(SRC, file)}: ${hit}`,
				),
			)
			.filter((o) => !ALLOWED_UUID_LINKS.includes(o));
		expect(offenders).toEqual([]);
		// Vacuity floor: a regex that drifts to match nothing would pass the
		// assertion above for the wrong reason. Today: 33 links, 13 paths,
		// 37 sinks; each floor sits just under so a few deletions pass, a drift fails.
		expect(seen.links).toBeGreaterThanOrEqual(LINK_FLOOR);
		expect(seen.paths).toBeGreaterThanOrEqual(PATH_FLOOR);
		expect(seen.sinks).toBeGreaterThanOrEqual(SINK_FLOOR);
	});
});
