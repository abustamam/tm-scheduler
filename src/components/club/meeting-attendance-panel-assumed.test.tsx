// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Same stub the panel's main suite needs: `GuestEditDialog` imports a server-fn
// module that pulls `#/db` → `pg` at import time.
vi.mock("#/server/guest-pipeline", () => ({ updateGuest: vi.fn() }));

import { MeetingAttendancePanel } from "./meeting-attendance-panel";

/**
 * #664: roll mode now suggests `Present?` for a confirmed role-holder who never
 * replied, from the same rule that makes the rail read `Coming · assumed`. The
 * suggestion must not claim a source it does not have — "the plan suggests" is
 * false when nobody planned anything — and it must look like the inference it
 * is, the way plan mode's assumed Coming does.
 */
describe("MeetingAttendancePanel (roll mode) — assumed suggestion", () => {
	afterEach(() => cleanup());

	const props = {
		mode: "roll" as const,
		roster: [
			{ id: "m-tm", name: "Tomi Ade", phone: null, email: null },
			{ id: "m-said", name: "Sade Bello", phone: null, email: null },
		],
		plan: [{ memberId: "m-said", status: "coming" as const }],
		attendance: [],
		rungOverride: {},
		roleByMemberId: {
			"m-tm": { code: "TM", roleName: "Toastmaster", confirmed: true },
		},
		meetingDate: "August 20, 2026",
		shareUrl: "https://example.test/m",
		locked: false,
		onWriteRung: vi.fn(),
		onContacted: vi.fn(),
		onSetAttendance: vi.fn(),
	};

	it("names the confirmed role as the source, and mutes it", () => {
		const { getByRole } = render(<MeetingAttendancePanel {...props} />);
		const assumed = getByRole("button", {
			name: "Tomi Ade status: not recorded — their confirmed role suggests Present. Tap to record it.",
		});
		expect(assumed.className).toContain("text-muted-foreground");
		expect(assumed.className).toContain("border-dashed");
	});

	it("leaves an ANSWERED suggestion's wording and colour alone", () => {
		const { getByRole } = render(<MeetingAttendancePanel {...props} />);
		const answered = getByRole("button", {
			name: "Sade Bello status: not recorded — the plan suggests Present. Tap to record it.",
		});
		expect(answered.className).not.toContain("text-muted-foreground");
	});

	it("commits the assumed suggestion in one tap, like any other", () => {
		const onSetAttendance = vi.fn();
		const { getByRole } = render(
			<MeetingAttendancePanel {...props} onSetAttendance={onSetAttendance} />,
		);
		getByRole("button", { name: /Tomi Ade status: not recorded/ }).click();
		expect(onSetAttendance).toHaveBeenCalledWith("m-tm", "present");
	});
});
