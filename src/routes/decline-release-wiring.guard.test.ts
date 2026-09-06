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

	it("asks on EVERY decline, never only when the page knows of a role", () => {
		// The first cut gated the dialog on `roleLabels.length > 0`, computed from
		// loader data against a rail that does not poll (CODING_STANDARDS.md). A
		// slot claimed since the page rendered is absent from that map while the
		// server frees it anyway — so the one case it skipped was the one where the
		// officer had the least idea what was about to happen. Same first-cut bug
		// `personal-meeting-body.tsx` documents for the sibling surface.
		const body = fnBody(RAW, "writeRung");
		expect(
			body,
			"the confirm must not be conditional on the page believing a role is held",
		).not.toMatch(/roleLabels\.length > 0/);
		expect(body).not.toMatch(/if \(\s*rolesFreedByDecline/);
	});

	it("passes the opt-in flag from the CONFIRM and nowhere else", () => {
		// `commitRung`'s parameter defaults to false, so every other caller —
		// `markAsked`, `setMyStatus`, the panel's chips — sends a payload the server
		// treats as "record the rung, free nothing". Only the dialog's action, which
		// has actually shown someone what would go, passes true.
		expect(SRC).toMatch(/releaseHeldRoles = false,/);
		expect(SRC).toContain("releaseHeldRoles,");
		expect(SRC).toMatch(
			/commitRung\(p\.memberId, "not_coming", "manual", true\)/,
		);
		// Exactly one call site passes it.
		expect(RAW.split('"not_coming", "manual", true').length - 1).toBe(1);
	});

	it("guards the confirmed write with its own in-flight flag", () => {
		// `writeRung` returns as soon as the dialog opens, so the panel's
		// `pendingId` and the strip's `myStatusBusy` have both cleared by the time
		// the officer answers. Without this the confirmed write — the only
		// destructive one on the page — would be the one guarded by nothing.
		expect(SRC).toContain("busy={declineBusy}");
		expect(SRC).toContain("if (declineBusy) return;");
		expect(SRC).toContain("setDeclineBusy(true);");
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
		expect(SRC).toMatch(/commitRung\(p\.memberId, "not_coming",/);
	});
});

describe("the confirm predicts the SERVER's arm (#663)", () => {
	it("reads canManage, never the preview-adjusted flag", () => {
		// `effectiveCanManage` is `canManage && !previewAsMember` (#320). The server
		// keys off the SESSION, which an admin previewing as a member still carries,
		// so the preview flag would mispredict on a path where the release lands.
		const body = fnBody(SRC, "declineFreesRoles");
		expect(body).toContain("canManage");
		expect(
			fnBody(RAW, "declineFreesRoles"),
			"the preview flag is not what the server sees",
		).not.toContain("effectiveCanManage");
	});

	it("matches the seam's arms: officer or the member's own row", () => {
		// `attendance-decline-logic.ts` releases on `officer`, on `self`, AND on the
		// Toastmaster's own row — the last because `resolveActor` orders the arms
		// officer → TMOD → self, so a TMOD declining for themselves resolves to
		// `tmod`. Reading `isTmod` here would put the copy back out of step with the
		// server on exactly that row.
		const body = fnBody(SRC, "declineFreesRoles");
		expect(body).toContain("canManage || memberId === myId");
		expect(
			fnBody(RAW, "declineFreesRoles"),
			"the own-row TMOD case releases server-side, so this must not exclude it",
		).not.toContain("isTmod");
	});

	it("hands the dialog what it needs to tell the truth", () => {
		// `willRelease` picks between "this frees the role" and "that stays
		// theirs". Dropped, the prop defaults to nothing and the dialog promises a
		// release the server may decline to make.
		const body = fnBody(SRC, "writeRung");
		expect(body).toContain("willRelease: declineFreesRoles(memberId)");
		expect(body).toContain("roleLabels: heldRolesByMember[memberId]?.labels");
	});

	it("derives its copy from a HELD value, not the live prop", () => {
		// The "Mark undefined not coming?" flash. Radix keeps the dialog mounted for
		// its exit transition, so on every close — confirm and cancel alike — the
		// component re-renders once with `pending === null` while the box is still
		// on screen, and anything reading `pending?.name` blanks mid-animation.
		//
		// It is asserted HERE, against the source, because jsdom cannot produce it:
		// no CSS animations run there, `getComputedStyle(node).animationName` is
		// "", and Presence unmounts on the same tick — so a render test passes
		// identically with the fix reverted. Same move CLAUDE.md records for the
		// dialog-keyboard gate: when the harness cannot produce the input, drive the
		// narrow interface the fix actually reads.
		const DIALOG = readSource(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"components",
				"club",
				"decline-release-dialog.tsx",
			),
		);
		expect(DIALOG).toContain(
			"const [shown, setShown] = useState<PendingDecline | null>(pending)",
		);
		expect(DIALOG).toContain("if (pending) setShown(pending)");
		// `open` is the ONE thing that may read the live prop — it is what drives
		// the animation this exists to survive.
		const readsLiveProp = DIALOG.split("\n").filter(
			(l) => l.includes("pending?.") || l.includes("pending."),
		);
		expect(
			readsLiveProp,
			"the rendered copy must come from `shown`; `pending` only drives `open`",
		).toEqual([]);
	});

	it("names roles from every slot the meeting has", () => {
		// `buildHeldRoleLabels` numbers a repeated role off how many slots it HAS,
		// so a filtered call renumbers the labels as the week fills and the dialog
		// names a different "Evaluator 2" from the agenda beside it.
		expect(SRC).toContain("buildHeldRoleLabels(slots)");
		expect(RAW).not.toMatch(/buildHeldRoleLabels\(slots\.filter/);
	});
});
