// @vitest-environment jsdom
//
// The meeting header is TWO components stacked (#541 D2/D3): the route renders
// <MeetingPersonalStrip> immediately followed by <MeetingToolbar>. Spec D2's
// promise — "exactly one emphasized action" — is therefore a property of the
// PAIR, and neither component's own suite can observe it, because each renders
// alone and each looks correct in isolation.
//
// That blind spot has already produced the same defect twice on this branch:
//   1. `Complete meeting` shipped at the filled `default` variant, so an
//      officer on meeting day saw it competing with the filled Present primary.
//      Found by /qa in a browser, not by the 3,669-test suite.
//   2. The fix for (1) added a filled-control COUNT assertion to
//      meeting-toolbar.test.tsx — but scoped to a render of the toolbar ALONE,
//      so it stayed green while the personal strip's marked-unavailable chip
//      (`variant="default"`) put a second filled control right above it. Found
//      by the ship design review.
//
// (2) is the interesting one: the regression test written for (1) was itself
// blind to (1)'s own failure mode one component over. So this file renders the
// composition and counts across it. Adding a third component to the header
// means adding it here too.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import type { StoredMember } from "#/lib/member-identity";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingPersonalStrip } from "./meeting-personal-strip";
import { MeetingToolbar } from "./meeting-toolbar";

const MEMBER: StoredMember = { id: "m1", name: "Nina Petrov" };

afterEach(cleanup);

/** Renders the header exactly as `club.$clubId.meeting.$meetingId.tsx` does. */
async function renderHeader(opts: {
	phase: MeetingPhase;
	over: boolean;
	myUnavailable: boolean;
	canManage: boolean;
	canComplete?: boolean;
	locked?: boolean;
}) {
	await renderUnderMemoryRouter(
		<>
			<MeetingPersonalStrip
				source="anon"
				member={MEMBER}
				promptIdentity={vi.fn()}
				over={opts.over}
				myStatus={opts.myUnavailable ? "not_coming" : null}
				availBusy={false}
				canToggleAvailability={true}
				onSetStatus={vi.fn()}
			/>
			<MeetingToolbar
				phase={opts.phase}
				clubSlug="downtown"
				meetingId="2026-08-10"
				dbMeetingId="11111111-2222-4333-8444-555555555555"
				sharePath="/club/downtown/meeting/2026-08-10"
				wordOfTheDay={null}
				hasIdentity={true}
				canManage={opts.canManage}
				locked={opts.locked ?? false}
				canComplete={opts.canComplete ?? false}
				hasAddableRoles={true}
				lifecycleBusy={false}
				onAddRole={vi.fn()}
				onComplete={vi.fn()}
				onReopen={vi.fn()}
			/>
		</>,
	);
}

/**
 * Filled controls in the composed header.
 *
 * Scoped to `[data-slot="button"]` on purpose: `DropdownMenuItem` ALSO stamps
 * `data-variant="default"` (src/components/ui/dropdown-menu.tsx), so a bare
 * `[data-variant="default"]` query counts menu items the moment anything opens
 * the export menu — it passes today only because the menu happens to be shut.
 */
function filledControls(): string[] {
	return [
		...document.querySelectorAll(
			'[data-slot="button"][data-variant="default"]',
		),
	].map((el) => el.textContent?.trim() ?? "");
}

describe("the composed meeting header keeps ONE emphasis (#541 D2)", () => {
	it.each([
		{
			label: "meeting day, officer, available",
			opts: {
				phase: "today" as MeetingPhase,
				over: false,
				myUnavailable: false,
				canManage: true,
				canComplete: true,
			},
			expected: /present/i,
		},
		{
			// The cell that regressed: the undo chip and the phase primary are
			// both rendered, stacked, and both were filled.
			label: "meeting day, officer, MARKED UNAVAILABLE",
			opts: {
				phase: "today" as MeetingPhase,
				over: false,
				myUnavailable: true,
				canManage: true,
				canComplete: true,
			},
			expected: /present/i,
		},
		{
			label: "meeting day, member, MARKED UNAVAILABLE",
			opts: {
				phase: "today" as MeetingPhase,
				over: false,
				myUnavailable: true,
				canManage: false,
			},
			expected: /present/i,
		},
		{
			label: "completed, officer",
			opts: {
				phase: "completed" as MeetingPhase,
				over: true,
				myUnavailable: false,
				canManage: true,
				locked: true,
			},
			expected: /minutes/i,
		},
	])("at most one filled control — $label", async ({ opts, expected }) => {
		await renderHeader(opts);
		const filled = filledControls();
		expect(
			filled,
			`expected the phase primary to be the ONLY filled control in the ` +
				`composed header, got: ${JSON.stringify(filled)}`,
		).toHaveLength(1);
		expect(filled[0]).toMatch(expected);
	});

	it("upcoming has NO phase primary, so nothing in the header is filled", async () => {
		// The negative control. Without it, a change that made everything
		// `outline` would satisfy every case above by removing the emphasis
		// entirely rather than by resolving the collision.
		await renderHeader({
			phase: "upcoming",
			over: false,
			myUnavailable: true,
			canManage: true,
		});
		expect(filledControls()).toHaveLength(0);
		// ...but the marked-unavailable chip is still visibly DISTINCT from the
		// unmarked state, which is what stops "make it all outline" from being a
		// passing answer to this whole file.
		const chip = screen.getByRole("button", { name: /undo/i });
		expect(chip.dataset.variant).toBe("secondary");
	});
});
