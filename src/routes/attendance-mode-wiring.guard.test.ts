// Route wiring for in person / online (#1049).
//
// The meeting route cannot mount in jsdom, and both toggle props are OPTIONAL
// on the panel (omitted ⇒ no toggle renders), so dropping one at the call site
// type-checks, lints clean and silently removes the feature. The decisions
// themselves are pure and tested where they live (`#/lib/attendance-mode`);
// this pins that the route actually routes through them.
//
// COMMENT-BLIND (`readSource`): every assertion is "must BE present".
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("attendance mode route wiring (#1049)", () => {
	const src = readSource(ROUTE);
	const panelTagAt = src.indexOf("<MeetingAttendancePanel");
	const panelProps = src.slice(panelTagAt, src.indexOf("/>", panelTagAt));

	/** The body of a function declared in the route, up to the next one. */
	function body(name: string): string {
		const at = src.indexOf(`async function ${name}(`);
		expect(at, `${name} not found in the route`).toBeGreaterThan(-1);
		const next = src.indexOf("async function ", at + 1);
		return src.slice(at, next === -1 ? undefined : next);
	}

	it("finds the panel's call site", () => {
		expect(panelTagAt).toBeGreaterThan(-1);
	});

	it("hands the panel both toggles", () => {
		expect(panelProps).toContain("onSetMode={writeAttendanceMode}");
		expect(panelProps).toContain("onSetGuestMode={setRollGuestMode}");
	});

	it("derives the default from the NORMALIZED join link and the location", () => {
		expect(src).toMatch(
			/const attendanceDefaultMode = defaultAttendanceMode\(\{\s*joinUrl,\s*location: meeting\.location,?\s*\}\)/,
		);
	});

	it("decides a status write's mode through presenceWriteMode, against the projected rows", () => {
		const b = body("writeAttendance");
		expect(b).toContain("presenceWriteMode(");
		expect(b).toContain("rollAttendance.find(");
		expect(b).toContain("defaultMode: attendanceDefaultMode");
	});

	it("sends the mode on BOTH halves of a presence write — online and queued", () => {
		const b = body("writePresence");
		expect(b).toMatch(/setAttendance\(\{\s*data: \{[^}]*\.\.\.withMode/);
		expect(b).toMatch(/type: "setAttendance",[\s\S]*\.\.\.withMode/);
	});

	it("records a guest add with the default, online and queued", () => {
		const b = body("addRollGuest");
		expect(b).toContain("const mode = attendanceDefaultMode");
		expect(b).toMatch(/addMinutesGuest\(\{ data: \{[^}]*mode \} \}\)/);
		expect(b.match(/\bmode,\n/g)?.length).toBe(2);
		// An ADD is insert-only: it must never claim to be the toggle, or the
		// default overwrites a present guest's recorded mode (#1049 review).
		expect(b).not.toContain("replaceMode");
	});

	it("writes a guest's toggle as an addGuest WITH the mode", () => {
		const b = body("setRollGuestMode");
		expect(b).toMatch(
			/addMinutesGuest\(\{\s*data: \{ meetingId: meeting\.id, guestId, mode, replaceMode: true \}/,
		);
		expect(b).toMatch(/type: "addGuest",[\s\S]*mode,\s*replaceMode: true,/);
	});
});
