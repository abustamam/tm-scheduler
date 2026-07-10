import { describe, expect, it } from "vitest";
import { selfAssertedViewer, sessionViewer } from "./meeting-viewer";

describe("sessionViewer", () => {
	it("grants the full management set to an admin", () => {
		const v = sessionViewer({ currentMemberId: "m1", canManage: true });
		expect(v).toEqual({
			currentMemberId: "m1",
			canManage: true,
			canAssign: true,
			canManageSpeakers: true,
			canToggleAvailability: false,
			canTakeOver: false,
			canEditOwnSpeech: false,
		});
	});

	it("grants nothing manage-y to a non-admin member", () => {
		const v = sessionViewer({ currentMemberId: "m1", canManage: false });
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canManageSpeakers).toBe(false);
		// Self-serve capabilities are the public surface's — never on here.
		expect(v.canToggleAvailability).toBe(false);
		expect(v.canTakeOver).toBe(false);
		expect(v.canEditOwnSpeech).toBe(false);
		expect(v.currentMemberId).toBe("m1");
	});

	it("keeps a null current member id (unlinked account)", () => {
		const v = sessionViewer({ currentMemberId: null, canManage: false });
		expect(v.currentMemberId).toBeNull();
	});
});

describe("selfAssertedViewer", () => {
	it("grants self-serve capabilities to a picked member", () => {
		const v = selfAssertedViewer({ memberId: "m1", isTmod: false });
		expect(v.currentMemberId).toBe("m1");
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canTakeOver).toBe(true);
		expect(v.canEditOwnSpeech).toBe(true);
		// Never an admin, and not TMOD here.
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canManageSpeakers).toBe(false);
	});

	it("adds assign + speaker management for the TMOD, but never canManage", () => {
		const v = selfAssertedViewer({ memberId: "m1", isTmod: true });
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canManage).toBe(false);
	});

	it("grants a read-only agenda to a visitor with no picked name", () => {
		const v = selfAssertedViewer({ memberId: null, isTmod: false });
		expect(v.currentMemberId).toBeNull();
		expect(v.canToggleAvailability).toBe(false);
		expect(v.canTakeOver).toBe(false);
		expect(v.canEditOwnSpeech).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canManageSpeakers).toBe(false);
	});
});
