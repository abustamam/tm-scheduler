import { describe, expect, it } from "vitest";
import { minutesAccess, seasonGridIncludesOutreach } from "./view-as-logic";

describe("seasonGridIncludesOutreach", () => {
	it("an admin gets it, and loses it in a preview", () => {
		expect(seasonGridIncludesOutreach({ isAdmin: true, asMember: false })).toBe(
			true,
		);
		expect(seasonGridIncludesOutreach({ isAdmin: true, asMember: true })).toBe(
			false,
		);
	});
	it("a member never gets it, preview or not", () => {
		expect(
			seasonGridIncludesOutreach({ isAdmin: false, asMember: false }),
		).toBe(false);
		expect(seasonGridIncludesOutreach({ isAdmin: false, asMember: true })).toBe(
			false,
		);
	});
});

describe("minutesAccess", () => {
	const admin = { isAdmin: true, impersonatingReadWrite: false };

	it("an admin edits and sees the minutes of an upcoming meeting", () => {
		expect(
			minutesAccess({ ...admin, asMember: false, status: "scheduled" }),
		).toEqual({ canEdit: true, visible: true });
	});

	it("in a preview an upcoming meeting's draft minutes are hidden, as for a member", () => {
		expect(
			minutesAccess({ ...admin, asMember: true, status: "scheduled" }),
		).toEqual({ canEdit: false, visible: false });
	});

	it("in a preview a completed meeting is visible with canEdit false", () => {
		expect(
			minutesAccess({ ...admin, asMember: true, status: "completed" }),
		).toEqual({ canEdit: false, visible: true });
	});

	it("a read-write impersonation edits, and previewing drops it too", () => {
		const rw = { isAdmin: false, impersonatingReadWrite: true };
		expect(
			minutesAccess({ ...rw, asMember: false, status: "scheduled" }).canEdit,
		).toBe(true);
		expect(
			minutesAccess({ ...rw, asMember: true, status: "scheduled" }),
		).toEqual({ canEdit: false, visible: false });
	});

	it("a plain member is unchanged by the preview", () => {
		const member = { isAdmin: false, impersonatingReadWrite: false };
		for (const asMember of [false, true]) {
			expect(
				minutesAccess({ ...member, asMember, status: "scheduled" }),
			).toEqual({ canEdit: false, visible: false });
			expect(
				minutesAccess({ ...member, asMember, status: "completed" }),
			).toEqual({ canEdit: false, visible: true });
		}
	});
});
