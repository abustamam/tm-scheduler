// @vitest-environment jsdom
//
// The meeting page's "one primary per person" rule (#1307, DESIGN.md), as the
// phase x persona table in the issue. The action area is the personal strip
// plus the toolbar, rendered together exactly as the route does, with the
// strip's `primary` prop taken from the route's own rule (`stripIsPrimary`)
// rather than hand-set, so a wrong rule fails here and not only in a browser.
//
// protects: exactly one filled button per cell, with the table's label.
// fails_when: a second control is filled (the collision #541 shipped twice), or
//   nothing is filled where the table names a primary.
// no_claim: Restore is a route-level button this file cannot render; the route
//   wiring guard pins it filled, and the cancelled rows here pin that the
//   strip and toolbar add NO second filled control beside it.
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));

import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import type { StoredMember } from "#/lib/member-identity";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingPersonalStrip } from "./meeting-personal-strip";
import { MeetingToolbar, stripIsPrimary } from "./meeting-toolbar";

const MEMBER: StoredMember = { id: "m1", name: "Nina Petrov" };

afterEach(cleanup);

type Persona = "officer" | "member" | "anonymous";

async function renderActionArea(opts: {
	phase: MeetingPhase;
	persona: Persona;
	cancelled?: boolean;
	canLineupBlast?: boolean;
}) {
	const cancelled = opts.cancelled ?? false;
	const canManage = opts.persona === "officer";
	const hasIdentity = opts.persona !== "anonymous";
	const completed = opts.phase === "completed";
	await renderUnderMemoryRouter(
		<>
			<MeetingPersonalStrip
				source="session"
				member={hasIdentity ? MEMBER : null}
				promptIdentity={vi.fn()}
				over={completed}
				myStatus={null}
				availBusy={false}
				canToggleAvailability={true}
				onSetStatus={vi.fn()}
				primary={stripIsPrimary({ phase: opts.phase, cancelled, canManage })}
			/>
			<MeetingToolbar
				phase={opts.phase}
				clubSlug="downtown"
				meetingId="2026-08-10"
				dbMeetingId="11111111-2222-4333-8444-555555555555"
				sharePath="/club/downtown/meeting/2026-08-10"
				wordOfTheDay={null}
				hasIdentity={hasIdentity}
				canManage={canManage}
				locked={completed}
				canComplete={true}
				hasAddableRoles={true}
				lifecycleBusy={false}
				onAddRole={vi.fn()}
				onComplete={vi.fn()}
				onReopen={vi.fn()}
				cancelled={cancelled}
				canCancel={!cancelled}
				onCancel={vi.fn()}
				canLineupBlast={opts.canLineupBlast}
				onLineupBlast={vi.fn()}
			/>
		</>,
	);
}

/** `[data-slot="button"]` so menu items (which also stamp data-variant) never count. */
function filled(): string[] {
	return [
		...document.querySelectorAll(
			'[data-slot="button"][data-variant="default"]',
		),
	].map((el) => el.textContent?.trim() ?? "");
}

describe("one filled button per phase x persona cell (#1307)", () => {
	it.each([
		{ phase: "upcoming", persona: "officer", label: /^I'll be there$/ },
		{ phase: "upcoming", persona: "member", label: /^I'll be there$/ },
		{ phase: "upcoming", persona: "anonymous", label: null },
		{ phase: "today", persona: "officer", label: /^Present$/ },
		{ phase: "today", persona: "member", label: /^I'll be there$/ },
		{ phase: "today", persona: "anonymous", label: null },
		{ phase: "completed", persona: "officer", label: /^Minutes$/ },
		{ phase: "completed", persona: "member", label: null },
		{ phase: "completed", persona: "anonymous", label: null },
	] as {
		phase: MeetingPhase;
		persona: Persona;
		label: RegExp | null;
	}[])("$phase, $persona: $label", async ({ phase, persona, label }) => {
		await renderActionArea({ phase, persona });
		const got = filled();
		if (label === null) {
			expect(got, "the table says no filled button in this cell").toEqual([]);
		} else {
			expect(
				got,
				`expected exactly one filled button, got ${got}`,
			).toHaveLength(1);
			expect(got[0]).toMatch(label);
		}
	});

	it.each([
		"upcoming",
		"today",
	] as MeetingPhase[])("cancelled (%s), officer: the strip and toolbar fill nothing, so Restore is the only filled action", async (phase) => {
		await renderActionArea({ phase, persona: "officer", cancelled: true });
		expect(filled()).toEqual([]);
	});

	it.each([
		"member",
		"anonymous",
	] as Persona[])("cancelled, %s: nothing filled", async (persona) => {
		await renderActionArea({ phase: "today", persona, cancelled: true });
		expect(filled()).toEqual([]);
	});

	it("a member with lineup access gains a Manage menu but still exactly one filled button", async () => {
		await renderActionArea({
			phase: "today",
			persona: "member",
			canLineupBlast: true,
		});
		expect(filled()).toEqual(["I'll be there"]);
	});
});

describe("stripIsPrimary mirrors the table", () => {
	it.each([
		{ phase: "upcoming", cancelled: false, canManage: true, want: true },
		{ phase: "upcoming", cancelled: false, canManage: false, want: true },
		{ phase: "today", cancelled: false, canManage: true, want: false },
		{ phase: "today", cancelled: false, canManage: false, want: true },
		{ phase: "completed", cancelled: false, canManage: true, want: false },
		{ phase: "completed", cancelled: false, canManage: false, want: false },
		{ phase: "upcoming", cancelled: true, canManage: true, want: false },
		{ phase: "today", cancelled: true, canManage: false, want: false },
	] as {
		phase: MeetingPhase;
		cancelled: boolean;
		canManage: boolean;
		want: boolean;
	}[])("$phase cancelled=$cancelled canManage=$canManage -> $want", ({
		want,
		...args
	}) => {
		expect(stripIsPrimary(args)).toBe(want);
	});
});
