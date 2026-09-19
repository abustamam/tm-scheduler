import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * `updateMeeting` must hand the patch writer the ADMIN arm of its own grant
 * (#792).
 *
 * ## The one line, and what deleting it costs
 *
 * `applyMeetingMetaPatch` refuses `meetingNumber` from a non-admin, and the
 * refusal is real: `meeting-meta-patch.integration.test.ts` calls the writer
 * directly with `canReschedule: false` and five tests fail with the check
 * removed. But every one of those tests SUPPLIES the flag. The only place the
 * flag is ever DERIVED is one property in `updateMeeting`'s handler, and that
 * derivation is invisible to the whole suite: a `createServerFn` cannot be
 * invoked from vitest, so the handler body has no behavioural surface at all.
 *
 * Delete that property and everything stays green — typecheck included, because
 * `MeetingMetaPatchInput.canReschedule` is OPTIONAL and the writer reads it as
 * `input.canReschedule ?? true`. The default is fail-OPEN, so the deletion does
 * not turn the feature off, it turns the CHECK off: every caller of
 * `updateMeeting` is then an admin as far as the writer can tell. The grant on
 * the other side of that is the widest one in the repo —
 * `resolveMeetingAgendaAuthz`'s `tmod-self-assert` arm needs no session, only a
 * meeting's public link and the Toastmaster's member id, which the #317
 * identity gate hands an anonymous caller the roster to pick from. They would
 * get `scheduledAt`, `lengthMinutes` and `meetingNumber` back, and the number is
 * not a one-row edit: `deriveMeetingNumber` treats a stored number as the ANCHOR
 * later meetings count forward from, so one write renumbers the club's season.
 *
 * ## Why a source guard and not a type
 *
 * A required `canReschedule` would be the stronger gate — `tsc` cannot be talked
 * past, and it would catch a NEW call site of `applyMeetingMetaPatch` that
 * forgets the flag, which this file cannot see. It was measured rather than
 * guessed, and the measurement is why it was not done here: making the field
 * required produces exactly 20 `TS2345` errors, 0 of them in production code and
 * 20 across three integration suites
 * (`meeting-meta-patch` 14, `meeting-manage` 5, `meeting-number-logic` 1). That
 * is 20 test edits whose answer is "the seeded admin, obviously" at every one,
 * for a fail-closed default this file gets for the price of one grep. If someone
 * later wants to pay for it, the change is the `?` on
 * `MeetingMetaPatchInput.canReschedule` plus those 20 sites, and this file can
 * retire with it.
 *
 * ## Pinned as a SEMANTIC, not as bytes
 *
 * It fails when the property is deleted, and when the flag stops coming from the
 * admin arm — `canReschedule: true`, or the wrong arm, or a negation. It does
 * NOT fail on reformatting, on a renamed authz local (the local's name is read
 * out of the `requireMeetingAgendaEditor` call rather than assumed), on quote
 * style, or on hoisting the comparison into a `const` above the call.
 *
 * Comment-blind (`#/test/guard-source`): every assertion here is of the "must BE
 * present" form, where a comment quoting the derivation is a false PASS.
 */

const MEETINGS = readSource(resolve(__dirname, "meetings.ts"));
const AUTHZ_LOGIC = readSource(resolve(__dirname, "meeting-authz-logic.ts"));

/**
 * One `export const <name> = createServerFn…` declaration. Anchoring inside the
 * construct we mean is the point: `meetings.ts` holds a dozen handlers, and a
 * file-wide grep for this derivation passes on any neighbour that happens to
 * make the same comparison for its own reasons.
 *
 * The boundary is the next TOP-LEVEL declaration — the first newline followed by
 * a non-whitespace character — not the next `\nexport `. MEASURED: the sibling
 * precedents end at `\nexport const`, and here that ran straight past
 * `updateMeeting` and over `updateWordOfTheDaySchema`, because the next thing in
 * the file is a module-private `const`. The floor below caught it. A
 * declaration's continuation lines are all indented, so column 0 is the honest
 * edge; blanked comment lines are whitespace and are simply included.
 */
function handlerBody(name: string): string {
	const start = MEETINGS.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in meetings.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const firstLineEnd = MEETINGS.indexOf("\n", start);
	const next = /\n(?=\S)/.exec(MEETINGS.slice(firstLineEnd));
	return MEETINGS.slice(
		start,
		next ? firstLineEnd + next.index : MEETINGS.length,
	);
}

const BODY = handlerBody("updateMeeting");

/**
 * The local bound to the grant, read rather than assumed. This is what makes the
 * assertion below survive `const authz` → `const grant`: the guard should fail
 * on a change of MEANING, and a rename is not one.
 */
const AUTHZ_LOCAL = (() => {
	const m = BODY.match(
		/const\s+(\w+)\s*=\s*await\s+requireMeetingAgendaEditor\s*\(/,
	);
	if (!m) {
		throw new Error(
			"updateMeeting no longer binds requireMeetingAgendaEditor's result to a local. The admin arm is resolved somewhere this guard cannot read — re-point it.",
		);
	}
	return m[1];
})();

/** The object literal passed to a call, brace-matched. `readSource` blanks
 *  comments in place (same length, same newlines), so braces stay balanced. */
function objectArgOf(source: string, callee: string): string {
	const call = new RegExp(`${callee}\\s*\\(\\s*\\{`).exec(source);
	if (!call) throw new Error(`${callee}({…}) not found in the handler.`);
	const open = source.indexOf("{", call.index);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0)
			return source.slice(open, i + 1);
	}
	throw new Error(`unbalanced braces in the ${callee}( argument.`);
}

describe("updateMeeting derives canReschedule from the admin arm (#792)", () => {
	it("finds the handler, and only it (vacuity floor)", () => {
		// Without this the greps below would pass on an empty string, or pass
		// because they matched the NEXT handler's correct code.
		expect(BODY.length).toBeGreaterThan(200);
		expect(BODY).toContain("applyMeetingMetaPatch");
		expect(BODY).not.toContain("updateWordOfTheDay");
	});

	it("resolves the caller through the agenda-editor grant", () => {
		// The thing the arm is read OFF. Swapping this for a gate that returns no
		// `via` would strand the assertion below with nothing to name.
		expect(BODY).toMatch(/await\s+requireMeetingAgendaEditor\s*\(/);
		expect(AUTHZ_LOCAL.length).toBeGreaterThan(0);
	});

	it("sets the flag from that grant's admin arm and nothing else", () => {
		// The whole guard. `[:=]` accepts both the property and a hoisted `const`;
		// either comparison order; any whitespace. What it does not accept is a
		// literal, a different arm, or `!==`.
		const adminArm = new RegExp(
			`canReschedule\\s*[:=]\\s*(?:` +
				`${AUTHZ_LOCAL}\\s*\\.\\s*via\\s*===\\s*["']admin["']` +
				`|["']admin["']\\s*===\\s*${AUTHZ_LOCAL}\\s*\\.\\s*via` +
				`)`,
		);
		expect(
			adminArm.test(BODY),
			"updateMeeting no longer derives `canReschedule` from " +
				`\`${AUTHZ_LOCAL}.via === "admin"\`. This is the ONLY place that ` +
				"decision is made, and `applyMeetingMetaPatch` defaults the flag to " +
				"TRUE when it is absent — so deleting or weakening it does not fail " +
				"closed, it hands a session-less `tmod-self-assert` caller the " +
				"reschedule fields and the club's meeting number (#792).",
		).toBe(true);
	});

	it("passes the flag into applyMeetingMetaPatch, not past it", () => {
		// Deriving it correctly and then not sending it is the same bug with an
		// extra step: the writer's `?? true` picks up an omitted flag either way.
		const args = objectArgOf(BODY, "applyMeetingMetaPatch");
		expect(args).toContain("...data");
		expect(
			/(?:^|[{,\s])canReschedule\s*[,:}]/.test(args),
			"the applyMeetingMetaPatch call no longer carries a `canReschedule` key.",
		).toBe(true);
	});

	it('keeps "admin" an arm of MeetingAgendaAuthz["via"] (cross-file seam)', () => {
		// The string above is only meaningful because the union still spells the
		// arm this way. `tsc` errors on a comparison to a non-member, so this is a
		// floor rather than the gate — it is here so a rename of the arm produces
		// a message about the seam instead of a bare regex miss.
		expect(AUTHZ_LOGIC).toMatch(
			/interface MeetingAgendaAuthz\s*\{[\s\S]*?via:\s*["']admin["']\s*\|/,
		);
	});
});
