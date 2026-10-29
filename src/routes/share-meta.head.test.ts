// Pins the link-preview `head` of the club routes people actually share.
// The meeting page is public but its roll is members-only: its head may carry
// the club name, date and theme and NOTHING roster-derived.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/server/role-feedback", () => ({
	getFeedbackTargetsPublic: vi.fn(),
	leaveFeedback: vi.fn(),
}));
vi.mock("#/server/voting", () => ({}));
vi.mock("#/server/guest-pipeline", () => ({}));
vi.mock("#/lib/auth-client", () => ({ authClient: {} }));
vi.mock("#/server/ballot-session-voter", () => ({}));

type Meta = Array<Record<string, string>>;
const metaOf = (route: unknown, args: object): Meta =>
	(
		(
			route as { options: { head: (a: object) => { meta: Meta } } }
		).options.head(args) as { meta: Meta }
	).meta;
const prop = (m: Meta, k: string) =>
	m.find((t) => t.property === k || t.name === k)?.content;

describe("QR-scanned routes keep noindex and gain a preview", () => {
	it("vote", async () => {
		const { Route } = await import("./club.$clubId_.meeting.$meetingId.vote");
		const m = metaOf(Route, {
			loaderData: { clubName: "Acme Speakers" },
			params: { clubId: "acme", meetingId: "2026-11-04" },
		});
		expect(m).toContainEqual({ title: "Vote — Acme Speakers" });
		expect(prop(m, "robots")).toBe("noindex, nofollow");
		expect(prop(m, "og:image")).toBe("https://gavelup.app/landing/hero.png");
	});
	it("feedback", async () => {
		const { Route } = await import(
			"./club.$clubId_.meeting.$meetingId.feedback"
		);
		const m = metaOf(Route, {
			loaderData: { clubName: "Acme Speakers" },
			params: { clubId: "acme", meetingId: "2026-11-04" },
		});
		expect(m).toContainEqual({ title: "Meeting feedback — Acme Speakers" });
		expect(prop(m, "robots")).toBe("noindex, nofollow");
	});
	it("guest book, and a missing loaderData does not throw", async () => {
		const { Route } = await import("./club.$clubId_.guest-book");
		const m = metaOf(Route, {
			loaderData: { clubName: "Acme Speakers" },
			params: { clubId: "acme" },
		});
		expect(m).toContainEqual({ title: "Acme Speakers guest book" });
		expect(prop(m, "robots")).toBe("noindex, nofollow");
		expect(
			metaOf(Route, { loaderData: undefined, params: { clubId: "acme" } }),
		).toBeTruthy();
	});
});

describe("sign-up sheet and meeting page heads (source-pinned)", () => {
	const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
	const headOf = (s: string) => {
		const i = s.indexOf("head: (");
		expect(i).toBeGreaterThan(-1);
		return s.slice(i, i + 1200);
	};

	it("sign-up sheet names the club", () => {
		const h = headOf(src("./club.$clubId.index.tsx"));
		expect(h).toContain("match.context.clubName");
		expect(h).toContain("sign up for meeting roles");
	});

	it("meeting head uses only club, date and theme, never the roll", () => {
		const h = headOf(src("./club.$clubId.meeting.$meetingId.tsx"));
		expect(h).toContain("match.context.clubName");
		expect(h).toContain("meetingHeading(");
		for (const banned of [
			"slots",
			"assignee",
			"person",
			"attendance",
			"present",
			"absent",
			"roll",
			"members",
			"signups",
		]) {
			expect(h.toLowerCase(), banned).not.toContain(banned);
		}
	});
});
