/**
 * WHICH agenda slots a measured time may be recorded against (#730).
 *
 * Declared once, here, and read by BOTH the surface that offers the button and
 * the server fn that performs the write — the #464/#510 rule. Two copies of
 * this predicate is two answers to "can this be recorded", and the pair that
 * disagrees is the one where the phone offers a control the server refuses.
 *
 * ## DERIVED from the columns, never a hand-written key list
 *
 * ```
 * isTimeableRole({ isSpeakerRole, category }) => isSpeakerRole || category === "evaluator"
 * ```
 *
 * That is `pickSpeakerAndEvaluatorRoles`'s own two-part heuristic
 * (`meeting-roles.ts`), and BOTH arms are load-bearing: `ROLE_TEMPLATE`'s
 * Evaluator is `isSpeakerRole: false`, so the flag alone is not a drop-in.
 *
 * This repo has already shipped the listed version's bug once, and
 * `role-duties.ts` records it: a hand-written key list keyed only on `speaker`
 * "told the one person in the room who demonstrably owes a speech that they owe
 * nothing." The role it missed was `contestant_prepared`, and that is the worst
 * possible one to miss HERE. `contest-template.ts` is the only beat in either
 * shipped template authored with hardcoded green/yellow/red marks AND a stated
 * qualifying window ("Qualifying window 4:30-7:30."), and because it sets
 * `repeatsRoleKey` it fans out one row per slot, so `slotId` is populated. A
 * `["speaker", "evaluator"]` list would render that clock and then refuse to
 * store it — on the one meeting shape where the window is not a courtesy but
 * the disqualification rule.
 *
 * `isSpeakerRole || category === "evaluator"` enrols `speaker`,
 * `contestant_prepared` and `evaluator` automatically, and
 * `timeable-roles.test.ts` sweeps BOTH role templates so the next marked
 * speaker-ish seed is caught by a red test rather than by whoever reviews it.
 *
 * ## The General Evaluator is excluded, and the repo already argued it
 *
 * `role-template.ts` puts the GE in `category: "leadership"` with the reason
 * stated: the GE runs the evaluation team rather than evaluating a speech, and
 * is not a Best Evaluator candidate. No beat gives the GE marks, so it never
 * reaches the surface anyway — `category === "evaluator"` excludes it for a
 * reason already settled here rather than by accident.
 *
 * ## What this deliberately refuses, and why refusing beats not building
 *
 * The Table Topics segment is ONE `AgendaRow` binding the Table Topics MASTER's
 * slot, and it carries marks. A naive "record against `AgendaRow.slotId`" would
 * therefore store one number for a segment with four to eight speakers,
 * attributed to the person who asked the questions. Nothing about that is a
 * constraint violation: it type-checks, inserts cleanly, and is simply wrong.
 * Deferring per-speaker Table Topics timings in prose does not close it —
 * refusing the TTM's slot does.
 *
 * ## Db-free, and that is a hard requirement
 *
 * The reader is a session-less CLIENT route. A module that reaches `#/db` drags
 * `pg` (and `Buffer`) into the browser and white-screens the page, and is also
 * unreachable from vitest. So this takes the two COLUMNS as plain arguments:
 * the server resolves the slot's `role_definitions` row and passes them, the
 * surface passes what its payload already carries. Same constraint
 * `role-duties.ts` spells out for itself.
 *
 * There is NO exact-name fallback here, deliberately. `meeting-roles.ts`
 * provides one only for the three capability roles plus the Timer, and the
 * speaker/contestant name map is module-private to `role-duties.ts`. A
 * NULL-`key` row is resolved by its COLUMNS here, which is strictly better than
 * a name match — the columns are what the database models.
 */

/** The two `role_definitions` columns the rule reads. `category` is `string`
 *  rather than the pgEnum union so an `AgendaSlot` (whose `category` is a plain
 *  string) satisfies it without a cast at the one call site that matters most. */
export interface TimeableRoleColumns {
	isSpeakerRole: boolean;
	category: string;
}

/** True when a slot holding this role may carry a recorded time. */
export function isTimeableRole(role: TimeableRoleColumns): boolean {
	return role.isSpeakerRole || role.category === "evaluator";
}

/**
 * The refusal, as its own error rather than an authorization failure.
 *
 * The distinction is the whole point of the message: "a Table Topics segment
 * can't be recorded" and "you're not allowed to record that" send the Timer to
 * two completely different places, and only one of them is true. A named class
 * so the server tests can assert WHICH refusal fired; the message is what
 * crosses the wire, because a thrown class does not survive a `createServerFn`
 * round trip.
 */
export class TimingNotRecordableError extends Error {
	readonly name = "TimingNotRecordableError";
	constructor(readonly roleName: string) {
		super(timingNotRecordableMessage(roleName));
	}
}

/** The sentence a refused row shows. Carries the ROLE NAME, so a Timer looking
 *  at eight cards knows which one refused and why. */
export function timingNotRecordableMessage(roleName: string): string {
	return `${roleName} isn't a speech or an evaluation, so there's no one speaker to record a time against.`;
}
