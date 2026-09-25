/**
 * Pins the lock ORDER in `saveMeetingAgendaAsClubTemplate` (#909 review). The
 * behavioural tests in `save-club-template.integration.test.ts` show the save
 * does not wait on a foreign-key lock and refuses an archived club; neither can
 * see WHERE the club lock is taken, and taking it after the materialise step
 * is the deadlock (the materialise insert's KEY SHARE, then a stronger lock).
 * Read comment-blind: every assertion is "this must BE in the code".
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/meeting-templates-logic.ts");

function body(name: string): string {
	const start = SOURCE.indexOf(`export async function ${name}(`);
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	return SOURCE.slice(start).split("\n}\n")[0] ?? "";
}

describe("saveMeetingAgendaAsClubTemplate's locks", () => {
	it("takes the club row NO KEY UPDATE, with the archive gate, before materialising", () => {
		const save = body("saveMeetingAgendaAsClubTemplate");
		const lock = save.indexOf('.for("no key update")');
		const archived = save.indexOf("CLUB_ARCHIVED_MESSAGE");
		const meetingLock = save.indexOf('.for("update")');
		const materialise = save.indexOf("materialiseAgendaForMeeting(");
		expect(lock).toBeGreaterThan(-1);
		expect(save.slice(0, lock)).toContain(".from(clubs)");
		expect(save.slice(0, lock)).toContain("archivedAt: clubs.archivedAt");
		expect(archived).toBeGreaterThan(lock);
		expect(meetingLock).toBeGreaterThan(archived);
		expect(materialise).toBeGreaterThan(archived);
	});

	it("keeps the key read's club lock at NO KEY UPDATE", () => {
		const key = body("nextClubTemplateKey");
		expect(key).toContain('.for("no key update")');
		expect(key).not.toContain('.for("update")');
	});

	it("forks legacy pointers BEFORE locking the replace target, then locks it", () => {
		const save = body("saveMeetingAgendaAsClubTemplate");
		const replaceArm = save.slice(save.indexOf('input.mode === "replace"'));
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
