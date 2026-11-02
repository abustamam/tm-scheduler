/**
 * The meeting-setup entries (Edit meeting, Edit Word of the Day, Change meeting
 * type) between the meeting route and the toolbar that renders them.
 *
 * They were buttons at the top of `<MeetingAgenda>`, each gated on a `viewer`
 * flag inside the component. They are the toolbar's now, and the toolbar is a
 * pure component that renders an entry for the flag it is HANDED, so the gate
 * is a prop expression on the route and the route is the only place a wrong one
 * can live: the #319 shape, a well-tested component reached through a wrong
 * prop. `meeting-toolbar.test.tsx` proves the toolbar honours whatever it is
 * given; it cannot see which flag the route gives it, and the route cannot be
 * mounted in vitest.
 *
 * Why `viewer.<flag>` and nothing else. `viewer` is built from
 * `effectiveCanManage` (the "Preview as member" answer) and `lockedViewer`
 * zeroes every flag on a completed or cancelled meeting, so a gate read off it
 * vanishes there for free. The toolbar's own `canEdit` is `canManage &&
 * !cancelled`: it would show Edit meeting on a COMPLETED meeting, and would
 * hide the Toastmaster's and Grammarian's entries (they are not managers) on
 * every meeting. `canManage` straight off the loader is the real admin even
 * while previewing as a member.
 *
 * Comment-blind, deliberately (`readSource`): the route's own comments quote
 * these expressions.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";
// The dialogs' handlers moved out of the route into `useMeetingLifecycle`
// (#1476); the route passes them straight through, and this reads the hook for
// what each one does.
const LIFECYCLE_HOOK = "src/components/club/use-meeting-lifecycle.ts";

/** The body of one function in the lifecycle hook, up to the next declaration. */
function hookFn(name: string): string {
	const hook = readSource(LIFECYCLE_HOOK);
	const at = hook.indexOf(`function ${name}(`);
	expect(at, `${name} not found in use-meeting-lifecycle.ts`).toBeGreaterThan(
		-1,
	);
	const next = hook.indexOf("\n\tasync function ", at + 1);
	const nextSync = hook.indexOf("\n\tfunction ", at + 1);
	const ends = [next, nextSync, hook.indexOf("\n\treturn {", at)].filter(
		(i) => i > -1,
	);
	return hook.slice(at, Math.min(...ends));
}

describe("meeting route → toolbar meeting-setup gates", () => {
	const src = readSource(ROUTE);
	const toolbar = src.match(/<MeetingToolbar[\s\S]*?\n\t{4}\/>/)?.[0] ?? "";

	it("finds the toolbar call", () => {
		expect(toolbar.length, "no <MeetingToolbar … /> found").toBeGreaterThan(0);
	});

	it.each([
		["canEditMeta", "viewer.canEditMeetingMeta"],
		["canEditWod", "viewer.canEditWod"],
		["canChangeType", "viewer.canManage"],
	])("%s is exactly `%s`", (prop, flag) => {
		expect(
			toolbar,
			`${prop} must be the \`viewer\` flag as is: ${flag}`,
		).toMatch(new RegExp(`\\b${prop}=\\{${flag.replace(".", "\\.")}\\}`));
	});

	it("Change meeting type loads its templates lazily, then opens the dialog", () => {
		expect(toolbar).toMatch(/onChangeType=\{openTemplateDialog\}/);
		const block = hookFn("openTemplateDialog");
		expect(block).toMatch(/listTemplatesForClub\(/);
		expect(block).toMatch(/setTemplateOpen\(true\)/);
	});

	it("a failed template fetch is a write-error toast, not an unhandled rejection", () => {
		const block = hookFn("openTemplateDialog");
		// The fetch AND the dialog open sit inside the `try`, so a failure never
		// opens the dialog onto an empty or stale list; the `catch` reports it
		// through the helper every other failed write on this route uses.
		expect(
			block,
			"openTemplateDialog must `try` the fetch, then open the dialog, and `catch` into showWriteError(…)",
		).toMatch(
			/try\s*\{[\s\S]*listTemplatesForClub\([\s\S]*setTemplateOpen\(true\)[\s\S]*\}\s*catch\s*\(\w+\)\s*\{[\s\S]*showWriteError\(/,
		);
	});
});

describe("meeting route → the setup dialogs", () => {
	const src = readSource(ROUTE);

	it.each([
		["MeetingWordOfTheDayDialog", "viewer.canEditWod"],
		["MeetingTemplateDialog", "viewer.canManage"],
		["MeetingMetaDialog", "viewer.canEditMeetingMeta"],
	])("<%s> renders only behind `%s`", (dialog, flag) => {
		expect(
			src,
			`<${dialog}> must sit directly behind {${flag} ? (…) : null}`,
		).toMatch(
			new RegExp(
				`\\{${flag.replace(".", "\\.")}\\s*\\?\\s*\\(\\s*<${dialog}\\b`,
			),
		);
	});

	it("only an officer may reschedule from the meta dialog", () => {
		expect(src).toMatch(/canReschedule=\{viewer\.canManage\}/);
	});

	it("each dialog refreshes the loader after a save, as the agenda's callback did", () => {
		for (const [dialog, prop, handler] of [
			["MeetingWordOfTheDayDialog", "onSaved", "onWodSaved"],
			["MeetingMetaDialog", "onSaved", "onMetaSaved"],
			["MeetingTemplateDialog", "onApply", "applyTemplate"],
		]) {
			const block =
				src.match(new RegExp(`<${dialog}\\b[\\s\\S]*?\\n\\t{5}/>`))?.[0] ?? "";
			expect(block.length, `no <${dialog} … /> found`).toBeGreaterThan(0);
			expect(
				block,
				`<${dialog}> must be handed the lifecycle hook's ${handler}`,
			).toContain(`${prop}={${handler}}`);
			expect(
				hookFn(handler),
				`${handler} must call router.invalidate() once it has written`,
			).toMatch(/router\.invalidate\(\)/);
		}
	});

	it("<MeetingAgenda> no longer carries the setup props", () => {
		const agenda = src.match(/<MeetingAgenda\b[\s\S]*?\n\t{6}\/>/)?.[0] ?? "";
		expect(agenda.length, "no <MeetingAgenda … /> found").toBeGreaterThan(0);
		for (const prop of [
			"templateKey",
			"timezone",
			"selfMemberId",
			"onMetaSaved",
			"effectiveMeetingNumber",
		]) {
			expect(
				agenda,
				`${prop} is not a MeetingAgenda prop any more`,
			).not.toMatch(new RegExp(`\\b${prop}=`));
		}
	});
});
