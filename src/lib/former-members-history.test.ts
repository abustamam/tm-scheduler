import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "#/server/activity-feed-logic";
import { formatActivity, MEMBERSHIP_ENDED_CHANGE } from "./activity-format";
import {
	CONVERT_REACTIVATED_FORMER_MESSAGE,
	CONVERT_REACTIVATED_MESSAGE,
	convertNoticeDescription,
} from "./guest-convert";
import type { MappedMember } from "./members-csv";
import {
	type ExistingPersonRow,
	FORMER_UPDATE_NOTE,
	planImport,
} from "./members-import-plan";
import { buildImportPreview } from "./roster-import";
import { flagFormerMatches } from "./roster-import-former";

describe("convert notice names a former wake-up (#1328)", () => {
	it("says was former, with the end date when known", () => {
		const text = convertNoticeDescription({
			reactivated: true,
			reactivatedFrom: "former",
			priorEndedAt: "2026-03-04",
			closedOfficerPositions: [],
		});
		expect(text).toBe(CONVERT_REACTIVATED_FORMER_MESSAGE("2026-03-04"));
		expect(text).toContain("was former, ended 2026-03-04");
	});
	it("omits the date when unknown", () => {
		const text = convertNoticeDescription({
			reactivated: true,
			reactivatedFrom: "former",
			priorEndedAt: null,
			closedOfficerPositions: [],
		});
		expect(text).toContain("(was former)");
	});
	it("keeps the inactive wording for a lapsed membership", () => {
		expect(
			convertNoticeDescription({
				reactivated: true,
				reactivatedFrom: "inactive",
				closedOfficerPositions: [],
			}),
		).toBe(CONVERT_REACTIVATED_MESSAGE);
	});
});

describe("activity feed words an End (#1328)", () => {
	it("reads 'ended <name>'s membership', not a details edit", () => {
		const e: ActivityEntry = {
			id: "1",
			action: "member_edit",
			createdAt: new Date(),
			actorName: "Rasheed",
			targetType: "member",
			roleName: null,
			meetingId: null,
			meetingScheduledAt: null,
			subjectName: "Pat",
			fromName: null,
			change: MEMBERSHIP_ENDED_CHANGE,
			status: null,
			guestName: null,
			guestLink: false,
			unlinked: false,
		};
		expect(formatActivity(e).summary).toBe("ended Pat's membership");
		expect(formatActivity({ ...e, change: null }).summary).toBe(
			"updated a member's details",
		);
	});
});

describe("preview flags a former member's name (#1328)", () => {
	const rows = [
		{ name: "Pat Former", email: "", phone: "", office: "" },
		{ name: "New Person", email: "", phone: "", office: "" },
		{ name: "Cur Rent", email: "", phone: "", office: "" },
	];
	const base = buildImportPreview(rows, [{ name: "Cur Rent", email: null }]);
	it("blocks the former match and leaves others alone", () => {
		const out = flagFormerMatches(base, ["pat former", "Cur Rent"]);
		expect(out.map((r) => [r.former, r.willImport])).toEqual([
			[true, false],
			[false, true],
			[false, false], // a current duplicate keeps its own reason
		]);
		expect(out[0]?.issues).toContain("duplicate");
	});
	it("is a no-op with no former members", () => {
		expect(flagFormerMatches(base, []).map((r) => r.willImport)).toEqual(
			base.map((r) => r.willImport),
		);
	});
});

describe("CSV plan states what the commit does with a former match (#1328)", () => {
	const person: ExistingPersonRow = {
		id: "p1",
		customerId: "PN-1",
		email: "a@x.test",
		name: "Pat",
		phone: null,
		heldBy: "this_club",
		heldElsewhere: false,
		linked: false,
	};
	const mapped: MappedMember = {
		customerId: "PN-1",
		name: "Pat",
		email: "a@x.test",
		phone: null,
		joinedAt: null,
		originalJoinDate: null,
		officerPosition: null,
		currentPosition: null,
	};
	const plan = (status: "active" | "former") =>
		planImport(
			[person],
			[{ id: "m1", personId: "p1", name: "Pat", status }],
			[mapped],
			new Map(),
		).rows[0];
	it("notes a former row", () => {
		expect(plan("former")?.action).toBe("update");
		expect(plan("former")?.note).toContain(FORMER_UPDATE_NOTE);
	});
	it("does not note an active row", () => {
		expect(plan("active")?.note ?? "").not.toContain("Former member");
	});
});
