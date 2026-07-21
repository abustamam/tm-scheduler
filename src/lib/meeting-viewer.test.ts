import { describe, expect, it } from "vitest";
import { meetingViewer } from "./meeting-viewer";

const base = {
	currentMemberId: "m1",
	canManage: false,
	isTmod: false,
	isGrammarian: false,
	isEditableWindow: true,
};

describe("meetingViewer", () => {
	it("admin gets the full management + meta-edit set, no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, canManage: true });
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false); // admins edit WOD via "Edit meeting"
		expect(v.canToggleAvailability).toBe(true);
	});

	it("a plain member gets self-serve, no management or meta-edit", () => {
		const v = meetingViewer(base);
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canEditMeetingMeta).toBe(false);
		expect(v.canEditWod).toBe(false);
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canTakeOver).toBe(true);
		expect(v.canEditOwnSpeech).toBe(true);
		expect(v.canClaim).toBe(true);
		expect(v.canReleaseOwn).toBe(true);
	});

	it("a non-admin TMOD gets assign/speakers/meta-edit but no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true });
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false); // TMOD edits WOD via "Edit meeting"
	});

	it("a pure Grammarian (not TMOD, not admin) gets the focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isGrammarian: true });
		expect(v.canEditWod).toBe(true);
		expect(v.canEditMeetingMeta).toBe(false);
	});

	it("a TMOD who is also Grammarian uses meta-edit, not the focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true, isGrammarian: true });
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
	});

	it("a null identity can do nothing mutating", () => {
		const v = meetingViewer({ ...base, currentMemberId: null });
		expect(v.canClaim).toBe(false);
		expect(v.canReleaseOwn).toBe(false);
		expect(v.canToggleAvailability).toBe(false);
		expect(v.canTakeOver).toBe(false);
		expect(v.canEditOwnSpeech).toBe(false);
	});

	it("a closed edit window disables meta-edit + WOD but leaves claim/release", () => {
		const admin = meetingViewer({
			...base,
			canManage: true,
			isEditableWindow: false,
		});
		expect(admin.canEditMeetingMeta).toBe(false);
		const gram = meetingViewer({
			...base,
			isGrammarian: true,
			isEditableWindow: false,
		});
		expect(gram.canEditWod).toBe(false);
		expect(gram.canClaim).toBe(true);
		expect(gram.canReleaseOwn).toBe(true);
	});
});
