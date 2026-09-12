// @vitest-environment jsdom
/**
 * The agenda editor's "Club settings" link carries the club whose agenda is
 * open — as a UUID (#685).
 *
 * ## The regression this file is really guarding
 *
 * The first cut of #685 read the club off the router:
 * `useParams({ strict: false }).clubId`. That is WRONG here and the wrongness is
 * invisible from inside this component. `/club/$clubId`'s `beforeLoad` runs
 * `resolveClubOrRedirect`, which redirects unless `identifier === club.slug`
 * (`club-route.ts`), so by the time the editor renders the segment is the club's
 * SLUG. The link therefore emitted `?club=<slug>`, the settings route matched it
 * against `context.clubs[].clubId` (UUIDs), nothing matched, and EVERY viewer —
 * including the single-club admins for whom the link worked before — was bounced
 * to `/dashboard`.
 *
 * That shipped past a component test because the test mounted the editor on a
 * flat synthetic route with no `/club/$clubId` parent, so canonicalisation never
 * ran, and hardcoded a UUID into the path. The test and its "pre-fix control"
 * both passed against production-broken code. Two lessons are baked in below:
 *
 * 1. The club is a PROP now, so the value's provenance is a compile-time fact
 *    rather than a mount-path assumption. `src/components/` contains no
 *    `useParams` at all, and the third test here keeps it that way.
 * 2. A rendered-href test cannot see whether the ROUTE hands over the right
 *    value. Only source can, so the wiring assertions below read the route file
 *    — and each is written to fail against the exact broken wiring, not merely
 *    to confirm the correct one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft, AgendaDraftRow } from "#/server/meeting-agenda-edit";
import { readSource } from "#/test/guard-source";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { AgendaEditor } from "./agenda-editor";

afterEach(cleanup);

const CLUB_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The Table Topics row — the one row whose detail panel carries the link. Its
 *  club-owned marks are what put the link there (#679). */
const TT_ROW: AgendaDraftRow = {
	id: "tt",
	sortOrder: 0,
	kind: "role",
	label: "Table Topics Master",
	detail: null,
	minutes: 5,
	roleKey: "table_topics_master",
	repeatsRoleKey: null,
	flex: true,
	handoff: false,
	markGreen: 1,
	markYellow: 1.8833333333333333,
	markRed: 2.75,
};

const DRAFT: AgendaDraft = {
	templateId: "tpl",
	templateName: "Standard",
	editable: true,
	rows: [TT_ROW],
	roles: [
		{
			key: "table_topics_master",
			name: "Table Topics Master",
			category: "leadership",
			defaultCount: 1,
			isSpeakerRole: false,
		},
	],
	slots: [],
	scheduledAt: "2026-09-30T02:00:00.000Z",
	timeZone: "America/Chicago",
	lengthMinutes: 90,
	geIntroducesFunctionaries: false,
};

const noop = vi.fn(async () => ({}) as never);

/** Render, open the Table Topics detail panel, return the link's href. */
async function settingsHref(clubUuid: string): Promise<string | null> {
	await renderUnderMemoryRouter(
		<AgendaEditor
			draft={DRAFT}
			clubUuid={clubUuid}
			onAddRow={vi.fn(async () => TT_ROW)}
			onUpdateRow={noop}
			onRemoveRow={noop}
			onMoveRow={noop}
			onRefresh={noop}
			onAddRole={noop}
			planRoleRemoval={vi.fn(async () => [])}
			onRemoveRole={noop}
		/>,
	);
	await userEvent
		.setup()
		.click(screen.getAllByRole("button", { name: "Show row details" })[0]);
	return within(screen.getByTestId("agenda-row-club-marks-tt"))
		.getByRole("link", { name: /Club settings/ })
		.getAttribute("href");
}

const AGENDA_ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx";
const EDITOR = "src/components/agenda/agenda-editor.tsx";

describe("the rendered link", () => {
	it("carries the club it was given", async () => {
		expect(await settingsHref(CLUB_UUID)).toBe(
			`/admin/club-settings?club=${CLUB_UUID}`,
		);
	});

	it("carries THAT club and not some other one", async () => {
		// The assertion that fails if the wrong value reaches the link: a second,
		// distinguishable club id must come out the other end unchanged. A test
		// that only ever passes one id cannot tell "reads its prop" from "prints a
		// constant".
		const other = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		expect(await settingsHref(other)).toBe(
			`/admin/club-settings?club=${other}`,
		);
	});
});

describe("the wiring that supplies it", () => {
	// Read comment-blind: these are "the pattern must BE present" assertions, and
	// this file's own header names every string they look for.
	const routeSrc = readSource(resolve(process.cwd(), AGENDA_ROUTE));

	it("passes the route CONTEXT's clubUuid to the editor", () => {
		expect(routeSrc).toMatch(
			/const\s*\{\s*clubUuid\s*\}\s*=\s*Route\.useRouteContext\(\)/,
		);
		expect(routeSrc).toMatch(
			/<AgendaEditor[\s\S]{0,200}?clubUuid=\{clubUuid\}/,
		);
	});

	it("never hands the $clubId URL SEGMENT over as the club uuid", () => {
		// THE assertion this round exists for. `resolveClubOrRedirect`
		// canonicalises that segment to the club's slug, so `clubUuid={clubId}`
		// reproduces the shipped bug exactly — and it type-checks, renders, and
		// passes every href test that hardcodes a uuid into its own fixture.
		expect(routeSrc).not.toMatch(/clubUuid=\{\s*clubId\s*\}/);
		expect(routeSrc).not.toMatch(/clubUuid=\{\s*params\.clubId\s*\}/);
	});

	it("keeps the club-shell canonicalisation that makes the segment a slug", () => {
		// The premise the two assertions above rest on. If this ever stops being
		// true the segment becomes usable and the reasoning recorded here — in
		// three docblocks and this file — is stale rather than wrong-but-harmless.
		// Read RAW, not comment-blind: an "offender must be absent" shape, where
		// stripping could only mask a real occurrence.
		const clubRoute = readFileSync(
			resolve(process.cwd(), "src/lib/club-route.ts"),
			"utf8",
		);
		expect(clubRoute).toContain("identifier !== club.slug");
	});

	it("reads no router state inside the editor component", () => {
		// `src/components/` has no `useParams` anywhere, and the hidden mount-path
		// dependency it created here is what made the broken version untestable.
		// An "offender must be absent" assertion, so RAW source deliberately: a
		// comment-blind read would let a real call hide behind a `//` on the same
		// line.
		const raw = readFileSync(resolve(process.cwd(), EDITOR), "utf8");
		expect(raw).not.toMatch(/\buseParams\s*\(/);
	});
});
