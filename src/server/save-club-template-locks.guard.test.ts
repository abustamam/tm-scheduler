/**
 * Pins the lock ORDER in `saveMeetingAgendaAsClubTemplate` (#909 reviews):
 * meeting FOR UPDATE, then club FOR NO KEY UPDATE with the archive gate under
 * it, then the materialise step. Meeting-before-club is the order
 * `ensureAgendaDraft`, conversion and `joinBallotAsGuest` take the two rows in;
 * the inverse deadlocked against a guest joining the ballot. The behavioural
 * half is in `save-club-template.integration.test.ts`; this half sees WHERE
 * each lock is taken, which a passing interleaving cannot.
 * Read comment-blind: every assertion is "this must BE in the code".
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/meeting-templates-logic.ts");

function body(name: string): string {
	// Exported or not: the save's transaction body is a private function.
	const start = SOURCE.indexOf(`async function ${name}(`);
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	return SOURCE.slice(start).split("\n}\n")[0] ?? "";
}

describe("saveMeetingAgendaAsClubTemplate's locks", () => {
	it("locks the meeting, then the club NO KEY UPDATE with the archive gate, then materialises", () => {
		const save = body("saveInTransaction");
		const meetingLock = save.indexOf('.for("update")');
		const clubLock = save.indexOf('.for("no key update")');
		const archived = save.indexOf("isClubArchived(club)");
		const materialise = save.indexOf("materialiseAgendaForMeeting(");
		expect(meetingLock).toBeGreaterThan(-1);
		expect(save.slice(0, meetingLock)).toContain(".from(meetings)");
		expect(clubLock).toBeGreaterThan(meetingLock);
		expect(save.slice(meetingLock, clubLock)).toContain(".from(clubs)");
		expect(save.slice(meetingLock, clubLock)).toContain(
			"archivedAt: clubs.archivedAt",
		);
		expect(archived).toBeGreaterThan(clubLock);
		expect(materialise).toBeGreaterThan(archived);
	});

	it("keeps the key read's club lock at NO KEY UPDATE", () => {
		const key = body("nextClubTemplateKey");
		expect(key).toContain('.for("no key update")');
		expect(key).not.toContain('.for("update")');
	});

	it("forks legacy pointers BEFORE locking the replace target, then locks it", () => {
		const save = body("saveInTransaction");
		const replaceArm = save.slice(save.indexOf("const ownedTarget"));
		const fork = replaceArm.indexOf("forkLegacyPointers(tx, templateId)");
		const lock = replaceArm.indexOf('.for("update")');
		const swap = replaceArm.indexOf(".delete(meetingTemplateBeats)");
		expect(fork).toBeGreaterThan(-1);
		expect(lock).toBeGreaterThan(fork);
		expect(swap).toBeGreaterThan(lock);
	});
});

describe("copyTemplateContent's source lock", () => {
	it("takes FOR SHARE on the source row before reading roles or beats", () => {
		const copy = body("copyTemplateContent");
		const share = copy.indexOf('.for("share")');
		expect(share).toBeGreaterThan(-1);
		expect(copy.indexOf(".from(meetingTemplateRoles)")).toBeGreaterThan(share);
		expect(copy.indexOf(".from(meetingTemplateBeats)")).toBeGreaterThan(share);
	});
});
