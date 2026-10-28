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

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

const UUID_VALUE = /(?:\.id|\.meetingId)\b/;
const ROUTE_LINK =
	/\/club\/\$clubId_?\/meeting\/\$meetingId[\w./$]*["'`][\s\S]{0,400}?params=\{\{([^}]*)\}\}/g;
const BUILT_PATH = /\/meeting\/\$\{([^}]*)\}/g;

function uuidMeetingLinks(source: string): string[] {
	const found: string[] = [];
	for (const m of source.matchAll(ROUTE_LINK)) {
		const value = m[1].match(/meetingId:\s*([^,}]+)/)?.[1]?.trim();
		if (value && UUID_VALUE.test(value)) found.push(`meetingId: ${value}`);
	}
	for (const m of source.matchAll(BUILT_PATH)) {
		if (UUID_VALUE.test(m[1])) found.push(`/meeting/\${${m[1]}}`);
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

	it("no source file builds a meeting link from a meeting's uuid", () => {
		const offenders = sourceFiles(SRC).flatMap((file) =>
			uuidMeetingLinks(readFileSync(file, "utf8")).map(
				(hit) => `${relative(SRC, file)}: ${hit}`,
			),
		);
		expect(offenders).toEqual([]);
	});
});
