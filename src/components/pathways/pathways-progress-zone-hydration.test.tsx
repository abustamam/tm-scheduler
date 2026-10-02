// @vitest-environment jsdom
//
// #1017: a win's month ("Aug 2026") was formatted with a fixed locale but no
// zone, so a speech on the evening of the 31st in the Americas is next month on
// the UTC server and this month in the browser. The month is now read in a
// named zone: the club's where the caller has one, UTC otherwise.
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PathViewModel } from "#/server/pathways-read-logic";
import {
	hydrateAcrossRuntimes,
	pinIntlTo,
	restoreIntl,
} from "#/test/hydration-across-runtimes";
import { PathwaysProgress } from "./pathways-progress";

afterEach(() => restoreIntl());

/** 03:00 UTC on Sep 1: Sep in UTC, still the evening of Aug 31 in Chicago. */
const DELIVERED = new Date("2026-09-01T03:00:00Z");

const PATH: PathViewModel = {
	courseCode: "8701",
	pathName: "Presentation Mastery",
	status: "current",
	ringPercent: 40,
	currentLevel: 1,
	complete: false,
	workingLevel: 1,
	projectsLeftAtWorkingLevel: 3,
	levels: [{ level: 1, completed: 1, total: 4, approved: false }],
	levelsSource: "basecamp",
	hasBasecamp: true,
	wins: [
		{
			projectId: "p1",
			level: 1,
			name: "Ice Breaker",
			speechTitle: "Hello",
			deliveredAt: DELIVERED,
			markedHere: false,
			awaitingProcessing: false,
		},
	],
	upNext: [],
	upNextElectives: null,
	upNextSeries: [],
};

const SERVER = () => pinIntlTo("en-US", "UTC");
const BROWSER = () => pinIntlTo("es-ES", "America/Los_Angeles");

describe("a win's month is read in a named zone (#1017)", () => {
	it("in the club's zone: hydrates clean and names the club's month", () => {
		const el = <PathwaysProgress paths={[PATH]} timeZone="America/Chicago" />;
		expect(hydrateAcrossRuntimes(el, SERVER, BROWSER)).toEqual([]);
		BROWSER();
		expect(renderToString(el)).toContain("Aug 2026");
	});

	it("with no zone: UTC on both passes, so they agree", () => {
		const el = <PathwaysProgress paths={[PATH]} />;
		expect(hydrateAcrossRuntimes(el, SERVER, BROWSER)).toEqual([]);
		BROWSER();
		expect(renderToString(el)).toContain("Sep 2026");
	});
});
