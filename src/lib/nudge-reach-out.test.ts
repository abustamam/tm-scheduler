import { describe, expect, it } from "vitest";
import { buildNudge } from "./nudge";

const base = {
	mode: "reachOut" as const,
	name: "Dana Drift",
	clubName: "Downtown Club",
	email: "dana@example.com",
};

describe("buildNudge reachOut (#1445)", () => {
	it("names the open role, the date and the link", () => {
		const n = buildNudge({
			...base,
			roleName: "Timer",
			meetingDate: "Wed, Nov 5",
			shareUrl: "https://x.test/m",
		});
		expect(n.message).toBe(
			"Hi Dana, we've missed you at Downtown Club! Timer is open on Wed, Nov 5. Want it? https://x.test/m",
		);
	});

	it("falls back to the meeting-only draft without a role", () => {
		const n = buildNudge({
			...base,
			roleName: null,
			meetingDate: "Wed, Nov 5",
			shareUrl: "https://x.test/m",
		});
		expect(n.message).toBe(
			"Hi Dana, we've missed you at Downtown Club. Hope to see you on Wed, Nov 5! https://x.test/m",
		);
	});

	it("falls back to 'soon' with no upcoming meeting, even if a role is given", () => {
		const n = buildNudge({ ...base, roleName: "Timer" });
		expect(n.message).toBe(
			"Hi Dana, we've missed you at Downtown Club. Hope to see you soon!",
		);
	});

	it("subjects the email with the club", () => {
		const n = buildNudge({ ...base });
		expect(decodeURIComponent(n.mailtoUrl ?? "")).toContain(
			"subject=We've missed you at Downtown Club",
		);
	});
});
