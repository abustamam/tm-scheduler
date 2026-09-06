import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The meeting page's CALL-SITE wiring for the decline confirm (#663).
 *
 * ## Why a source guard
 *
 * The route imports `#/server/*` → `#/db` and throws `DATABASE_URL is not set`
 * on import, so it cannot be mounted in vitest — CLAUDE.md's "a component tested
 * through its props cannot see a WRONG prop", where the props are computed. The
 * two halves this change adds ARE render-tested elsewhere:
 * `decline-release-dialog.test.tsx` covers the copy and the buttons,
 * `attendance-decline.integration.test.ts` covers what the server does. What
 * neither can see is which function the panel is handed.
 *
 * That is the whole risk here, and it is a one-token mutation that typechecks
 * clean: `onWriteRung={commitRung}` has the same signature as
 * `onWriteRung={writeRung}` and skips the confirm entirely, so every officer tap
 * on "Not coming" would free the member's roles with nothing asked and nothing
 * on screen saying so. Same for the personal strip's `setMyStatus`.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`): "must BE
 * present" is comment-blind, since this route documents its own wiring in prose;
 * "must be ABSENT" is verbatim, because stripping only deletes text and could
 * erase a real offender.
 */
const FILE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);
/** Comment-blind — for "must BE present" only. */
const SRC = readSource(FILE);
/** Verbatim — for "must be ABSENT" only. */
const RAW = readFileSync(FILE, "utf8");

/** One `function <name>(`/`async function <name>(` declaration inside the route
 *  component, bounded by the next sibling declaration — so a per-function
 *  assertion cannot be satisfied by its neighbour's correct code. */
function fnBody(source: string, name: string): string {
	const start = source.search(
		new RegExp(`\\n\\t(?:async )?function ${name}\\(`),
	);
	if (start === -1) {
		throw new Error(
			`${name} not found in the meeting route — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.slice(start + 1).search(/\n\t(?:async )?function \w+\(/);
	return next === -1
		? source.slice(start)
		: source.slice(start, start + 1 + next);
}

describe("the decline confirm is on the write path, not beside it (#663)", () => {
	it("writeRung intercepts not_coming BEFORE it writes", () => {
		const body = fnBody(SRC, "writeRung");
		expect(
			body,
			"the intercept IS the confirm — without it the release happens on the tap",
		).toContain('if (next === "not_coming")');
		expect(body).toContain("setPendingDecline({");
		// Order: the intercept must precede the write it guards. Hoisted below it,
		// the write lands and the dialog then asks about a release already made.
		expect(body.indexOf("setPendingDecline({")).toBeLessThan(
			body.indexOf("commitRung("),
		);
	});

	it("writeRung touches no optimistic state on the intercepted path", () => {
		// `setRungOverride` belongs to `commitRung`. Called here too, a cancelled
		// confirm would leave the chip reading "Not coming" against a server that
		// was never told — and the reconciling effect only drops an override once a
		// fresh payload arrives, so it would sit there until something else on the
		// page invalidated.
		expect(fnBody(RAW, "writeRung")).not.toContain("setRungOverride(");
	});

	it("commitRung is the one that actually writes", () => {
		expect(fnBody(SRC, "commitRung")).toContain("setPlannedAttendance({");
	});

	it("the rail is handed the INTERCEPTING writer", () => {
		// The mutation this file exists for. Both functions have the same
		// signature, so the swap typechecks and every gate but this one stays green.
		expect(SRC).toContain("onWriteRung={writeRung}");
		expect(RAW, "onWriteRung must not bypass the confirm").not.toContain(
			"onWriteRung={commitRung}",
		);
	});

	it("the personal strip goes through the same intercept", () => {
		// It writes `not_coming` for the viewer's OWN row, which is a releasing arm.
		// Wired straight to `commitRung` it would be the one surface on this page
		// that frees a member's roles without asking.
		const body = fnBody(SRC, "setMyStatus");
		expect(body).toContain("await writeRung(");
		expect(fnBody(RAW, "setMyStatus")).not.toContain("commitRung(");
	});

	it("the confirm's own action writes, and writes not_coming", () => {
		expect(SRC).toContain("pending={pendingDecline}");
		expect(SRC).toMatch(/commitRung\(p\.memberId, "not_coming"\)/);
	});
});

describe("the confirm predicts the SERVER's arm (#663)", () => {
	it("reads canManage, never the preview-adjusted flag", () => {
		// `effectiveCanManage` is `canManage && !previewAsMember` (#320). The server
		// keys off the SESSION, which an admin previewing as a member still carries,
		// so the preview flag would under-predict on the one path where the release
		// still lands — the dialog would not appear and the roles would go anyway.
		const body = fnBody(SRC, "rolesFreedByDecline");
		expect(body).toContain("canManage");
		expect(
			fnBody(RAW, "rolesFreedByDecline"),
			"the preview flag is not what the server sees",
		).not.toContain("effectiveCanManage");
	});

	it("excludes the self-asserted Toastmaster, matching the seam", () => {
		// `attendance-decline-logic.ts` releases on `officer` and `self` only, and
		// `resolveActor` orders the arms officer → TMOD → self — so a TMOD resolves
		// to `tmod` even on their own row. Without `!isTmod` here the dialog would
		// promise a release the server then declines to make.
		expect(fnBody(SRC, "rolesFreedByDecline")).toContain(
			"memberId === myId && !isTmod",
		);
	});

	it("names roles from every slot the meeting has", () => {
		// `buildHeldRoleLabels` numbers a repeated role off how many slots it HAS,
		// so a filtered call renumbers the labels as the week fills and the dialog
		// names a different "Evaluator 2" from the agenda beside it.
		expect(SRC).toContain("buildHeldRoleLabels(slots)");
		expect(RAW).not.toMatch(/buildHeldRoleLabels\(slots\.filter/);
	});
});
