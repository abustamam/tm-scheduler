// Pins the link-preview `head` of the club routes people actually share.
// The meeting page is public but its roll is members-only: its head may carry
// the club name, date and theme and NOTHING roster-derived.
import { describe, expect, it, vi } from "vitest";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/server/role-feedback", () => ({
	getFeedbackTargetsPublic: vi.fn(),
	leaveFeedback: vi.fn(),
}));
vi.mock("#/server/voting", () => ({}));
vi.mock("#/server/guest-pipeline", () => ({}));
vi.mock("#/db", () => ({ db: {} }));
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
		const fallback = metaOf(Route, {
			loaderData: undefined,
			params: { clubId: "acme" },
		});
		expect(fallback).toContainEqual({ title: "Club guest book" });
	});
});

const count = (m: Meta, k: string) =>
	m.filter((t) => t.property === k || t.name === k).length;

describe("sign-up sheet head", () => {
	it("names the club, is absolute, and does not duplicate robots", async () => {
		const { Route } = await import("./club.$clubId.index");
		const m = metaOf(Route, {
			match: { context: { clubName: "Acme Speakers" } },
			params: { clubId: "acme" },
		});
		expect(m).toContainEqual({
			title: "Acme Speakers — sign up for meeting roles",
		});
		expect(prop(m, "og:url")).toBe("https://gavelup.app/club/acme");
		expect(count(m, "robots")).toBe(0);
	});
});

describe("meeting page head", () => {
	const SENTINEL = "Zelda Sentinel";
	const call = async (loaderData: unknown) => {
		const { Route } = await import("./club.$clubId.meeting.$meetingId");
		return metaOf(Route, {
			match: { context: { clubName: "Acme Speakers" } },
			params: { clubId: "acme", meetingId: "2026-11-04" },
			loaderData,
		});
	};
	const base = {
		timezone: "America/Chicago",
		meeting: {
			theme: null as string | null,
			status: "scheduled",
			scheduledAt: "2026-11-05T01:00:00.000Z",
		},
	};

	it("themed meeting: club and theme in the title", async () => {
		const m = await call({
			...base,
			meeting: { ...base.meeting, theme: "Fleeting Moments" },
		});
		expect(m).toContainEqual({ title: "Acme Speakers · Fleeting Moments" });
		expect(prop(m, "og:url")).toBe(
			"https://gavelup.app/club/acme/meeting/2026-11-04",
		);
	});

	it("no theme: the club-local date is the heading", async () => {
		const m = await call(base);
		expect(m).toContainEqual({ title: "Acme Speakers · Wed, Nov 4" });
		expect(prop(m, "description")).toBe(
			"Acme Speakers meeting agenda and roles.",
		);
	});

	it("loaderData undefined falls back to the club name", async () => {
		const m = await call(undefined);
		expect(m).toContainEqual({ title: "Acme Speakers" });
	});

	it("a cancelled meeting says so", async () => {
		const m = await call({
			...base,
			meeting: { ...base.meeting, status: "cancelled" },
		});
		expect(m).toContainEqual({
			title: "Cancelled: Acme Speakers · Wed, Nov 4",
		});
		expect(prop(m, "description")).toMatch(/^This meeting is cancelled\./);
	});

	it("PRIVACY: no roster field reaches any meta tag", async () => {
		const m = await call({
			...base,
			meeting: {
				...base.meeting,
				theme: "Fleeting Moments",
				createdBy: SENTINEL,
				notes: SENTINEL,
			},
			slots: [
				{
					assigneeId: "p1",
					assigneeName: SENTINEL,
					personName: SENTINEL,
					assigneeGuestId: null,
					speaker: { name: SENTINEL },
				},
			],
			rsvps: [{ memberId: "p1", name: SENTINEL, status: "coming" }],
			attendance: [{ name: SENTINEL, present: true }],
			upcoming: [{ theme: SENTINEL }],
			presentCount: 7,
		});
		const all = JSON.stringify(m);
		expect(all).not.toContain(SENTINEL);
		expect(all).not.toContain("coming");
	});
});

describe("resources head", () => {
	it("an unknown slug gets a non-empty description", async () => {
		vi.doMock("#/server/auth-context", () => ({ getAuthContext: vi.fn() }));
		const { Route } = await import("./resources.$slug");
		const m = metaOf(Route, { params: { slug: "no-such-resource" } });
		expect(prop(m, "description")).toBe("Toastmasters resources from GavelUp.");
	});
});
