// A cancelled meeting is visible, read-only, and says so, on every surface a
// link can land on (#1057; the maintainer's decision on #1084).
//
// Route wiring pins for the halves no behavioural test can reach: the present
// route has no route test that mounts it, the four personal duty editors mount
// only under a router context with a mocked `#/db`, and the agenda editor's
// copy is chosen inside a component tested through its props. Each pin names
// an expression that is same-typed with a plausible wrong one (a dropped
// `cancelled ?`, a check placed AFTER the identity gate), and silent when
// wrong: the page renders, it just presents a cancelled meeting as live.
//
// Two READERS, one per assertion class (`src/test/guard-source.ts`): "must BE
// present" reads comment-blind (`readSource`), so a comment naming the
// expression cannot satisfy it; "must be ABSENT" reads raw, so stripping can
// never erase the offending call from the text searched.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));
const route = (name: string) => readSource(resolve(ROUTES, name));
const rawRoute = (name: string) => readFileSync(resolve(ROUTES, name), "utf8");
const flat = (src: string) => src.replace(/\s+/g, " ");

describe("the main meeting page says cancelled to EVERYONE (#1057)", () => {
	it("the banner's condition is the status alone — no identity, no officer gate", () => {
		// The anonymous public view is the one a stale link or a printed QR
		// lands on. Officer controls inside the banner are gated (the cancel
		// wiring guard pins that); the banner itself must not be.
		expect(flat(route("club.$clubId.meeting.$meetingId.tsx"))).toContain(
			'{cancelled ? ( <div data-testid="cancelled-banner"',
		);
	});
});

describe("officer artifacts mark a cancelled meeting (#1057)", () => {
	for (const file of [
		"club.$clubId_.meeting.$meetingId.print.tsx",
		"club.$clubId_.meeting.$meetingId.word.tsx",
		"club.$clubId_.meeting.$meetingId.present.tsx",
	]) {
		it(`${file} reads the flag off the meeting it loaded`, () => {
			expect(route(file)).toContain(
				'cancelled: data.meeting.status === "cancelled",',
			);
		});
	}

	it("the flyer reads it off its OWN projected meeting", () => {
		expect(flat(route("club.$clubId_.meeting.$meetingId.flyer.tsx"))).toContain(
			"cancelled: isMeetingCancelled(meeting.status),",
		);
	});

	// A second status lookup beside a page's own reader is what Codex found
	// failing OPEN on the flyer: when it failed, a cancelled meeting printed as
	// a live invitation. Each page now reads the status off its own payload.
	for (const file of [
		"club.$clubId_.meeting.$meetingId.flyer.tsx",
		"club.$clubId_.meeting.$meetingId.feedback.tsx",
	]) {
		it(`${file} asks no second reader for the status`, () => {
			expect(rawRoute(file)).not.toContain("getPublicMeetingByKey");
		});
	}

	for (const file of [
		"club.$clubId_.meeting.$meetingId.print.tsx",
		"club.$clubId_.meeting.$meetingId.word.tsx",
		"club.$clubId_.meeting.$meetingId.flyer.tsx",
	]) {
		it(`${file} marks the toolbar on screen and the sheet on paper`, () => {
			const src = flat(route(file));
			expect(src).toContain("{cancelled ? <CancelledWatermark /> : null}");
			expect(src).toContain(
				"leading={cancelled ? <CancelledArtifactMarker /> : undefined}",
			);
		});
	}

	it("the projected deck carries the watermark over every slide", () => {
		expect(
			flat(route("club.$clubId_.meeting.$meetingId.present.tsx")),
		).toContain("{data.cancelled ? <CancelledWatermark /> : null}");
	});
});

describe("the personal duty editors are read-only on a cancelled meeting (#1057)", () => {
	for (const tool of ["theme", "timer", "topics", "word"]) {
		const file = `club.$clubId.meeting.$meetingId_.me_.${tool}.tsx`;
		it(`/me/${tool} shows the notice, AHEAD of the identity gate`, () => {
			const src = route(file);
			const check = src.indexOf("if (isMeetingCancelled(meeting.status)) {");
			const gate = src.indexOf("if (!myId) {");
			expect(check, `${file} has no cancelled check`).toBeGreaterThan(-1);
			expect(
				check,
				`${file}: the cancelled check must come before the identity gate, or ` +
					"a visitor with no name picked is asked who they are before being " +
					"told there is nothing to do.",
			).toBeLessThan(gate);
			expect(flat(src.slice(check, gate))).toContain(
				"return <CancelledMeetingNotice clubId={clubId} meetingId={meeting.id} />;",
			);
		});
	}
});

describe("the agenda editor says cancelled, not 'already happened' (#1057)", () => {
	it("chooses its read-only sentence off the server's `cancelled`", () => {
		const editor = flat(
			readSource(resolve(ROUTES, "../components/agenda/agenda-editor.tsx")),
		);
		expect(editor).toContain(
			'{draft.cancelled === true ? "This meeting is cancelled, so its agenda is read-only." : "This meeting\'s agenda is read-only now — it already happened."}',
		);
	});
});
