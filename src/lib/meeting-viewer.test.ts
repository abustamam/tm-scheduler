import { describe, expect, it } from "vitest";
import { meetingViewer } from "./meeting-viewer";

// Default fixture = an anonymous self-serve (name-pick) identity: has an id but
// is NOT signed in. This is the honor-system path that must NOT be able to boot.
const base = {
	currentMemberId: "m1" as string | null,
	canManage: false,
	isTmod: false,
	isGrammarian: false,
	isEditableWindow: true,
	isSignedIn: false,
};

describe("meetingViewer", () => {
	it("admin gets the full management + meta-edit set, no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, canManage: true, isSignedIn: true });
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
		expect(v.canToggleAvailability).toBe(true);
	});

	it("an anonymous name-pick member can claim/release/toggle but CANNOT take over", () => {
		const v = meetingViewer(base);
		expect(v.canClaim).toBe(true);
		expect(v.canReleaseOwn).toBe(true);
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canEditOwnSpeech).toBe(true);
		expect(v.canTakeOver).toBe(false); // honor-system path may not boot a held role
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
	});

	it("a signed-in member additionally gets take-over", () => {
		const v = meetingViewer({ ...base, isSignedIn: true });
		expect(v.canTakeOver).toBe(true);
		expect(v.canClaim).toBe(true);
		expect(v.canReleaseOwn).toBe(true);
	});

	it("a prospective visitor (no identity) is offered claim + availability, nothing that needs a held slot", () => {
		const v = meetingViewer({ ...base, currentMemberId: null });
		expect(v.canClaim).toBe(true); // offered — identity resolved at click
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canTakeOver).toBe(false);
		expect(v.canReleaseOwn).toBe(false); // holds no slot yet
		expect(v.canEditOwnSpeech).toBe(false);
	});

	it("a prospective visitor who is somehow signed-in is still offered take-over via isSignedIn", () => {
		const v = meetingViewer({
			...base,
			currentMemberId: null,
			isSignedIn: true,
		});
		expect(v.canTakeOver).toBe(true);
	});

	it("a non-admin TMOD gets assign/speakers/meta-edit but no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true });
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
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

	it("a closed edit window disables meta-edit + WOD but leaves claim/release", () => {
		const admin = meetingViewer({
			...base,
			canManage: true,
			isSignedIn: true,
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
