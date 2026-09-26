import { describe, expect, it } from "vitest";
import {
	checkVpeDom,
	checkVpmDom,
	devLoginPreflightError,
	devLoginUrl,
	framingProblem,
	isLocalBaseUrl,
	sliceById,
} from "./marketing-screenshot-checks";

describe("isLocalBaseUrl", () => {
	it("accepts localhost and 127.0.0.1 on any port", () => {
		expect(isLocalBaseUrl("http://localhost:3000")).toBe(true);
		expect(isLocalBaseUrl("http://127.0.0.1:3100")).toBe(true);
		expect(isLocalBaseUrl("http://localhost")).toBe(true);
	});

	it("refuses a deployed host, a look-alike and garbage", () => {
		expect(isLocalBaseUrl("https://gavelup.app")).toBe(false);
		expect(isLocalBaseUrl("http://localhost.gavelup.app")).toBe(false);
		expect(isLocalBaseUrl("http://127.0.0.2:3000")).toBe(false);
		expect(isLocalBaseUrl("not a url")).toBe(false);
	});
});

describe("devLoginUrl", () => {
	it("sends the fragment inside `redirect`, not as dev-login's own", () => {
		const url = devLoginUrl(
			"http://localhost:3000",
			"priya+vpe@example.com",
			"/admin/vpe-dashboard#close-to-a-level",
		);
		expect(url).toBe(
			"http://localhost:3000/api/dev-login?email=priya%2Bvpe%40example.com&redirect=%2Fadmin%2Fvpe-dashboard%23close-to-a-level",
		);
		const parsed = new URL(url);
		expect(parsed.hash).toBe("");
		expect(parsed.searchParams.get("redirect")).toBe(
			"/admin/vpe-dashboard#close-to-a-level",
		);
	});
});

describe("devLoginPreflightError", () => {
	it("passes a 302", () => {
		expect(devLoginPreflightError(302, "")).toBeNull();
	});

	it("names ENABLE_DEV_LOGIN on a 404", () => {
		expect(devLoginPreflightError(404, "Not found")).toMatch(
			/ENABLE_DEV_LOGIN=1/,
		);
	});

	it("prints the body on a 500, which names the email", () => {
		expect(
			devLoginPreflightError(
				500,
				"dev-login: no magic link captured for x@example.com (is it a seeded user?)\n",
			),
		).toMatch(/no magic link captured for x@example\.com/);
	});

	it("refuses anything else", () => {
		expect(devLoginPreflightError(200, "<html>")).toMatch(/200, not 302/);
	});
});

describe("sliceById", () => {
	it("returns the element through its MATCHING close tag, past nested ones", () => {
		const html =
			'<main><div id="x" class="a"><div>one</div><div>two</div></div><div>after</div></main>';
		expect(sliceById(html, "x")).toBe(
			'<div id="x" class="a"><div>one</div><div>two</div></div>',
		);
	});

	it("is null when the id is absent or the element never closes", () => {
		expect(sliceById("<div>nothing</div>", "x")).toBeNull();
		expect(sliceById('<div id="x"><div>open', "x")).toBeNull();
	});

	it("does not count a longer tag name that starts the same", () => {
		const html = '<div id="x"><dialog></dialog>in</div><div>out</div>';
		expect(sliceById(html, "x")).toBe('<div id="x"><dialog></dialog>in</div>');
	});
});

const vpe = (rows: string) =>
	`<div id="close-to-a-level"><h2>Close to a level</h2><div>${rows}</div></div><div><h2>Speaker queue</h2><p>Dynamic Leadership · Level 1 · 1 left: Ice Breaker</p></div>`;

describe("checkVpeDom", () => {
	it("passes a section with a named row", () => {
		expect(
			checkVpeDom(
				vpe("<p>Dynamic Leadership · Level 1 · 1 left: Evaluation and Feedback</p>"),
			),
		).toBeNull();
	});

	it("fails when the section is missing", () => {
		expect(checkVpeDom("<div>Close to a level 1 left: x</div>")).toMatch(
			/no element with id="close-to-a-level"/,
		);
	});

	it("fails on a bare count, and does not read a row from outside the section", () => {
		expect(checkVpeDom(vpe("<p>Dynamic Leadership · Level 1 · 2 left</p>"))).toMatch(
			/no row naming what is left/,
		);
	});

	it("fails when the heading is not inside the section", () => {
		expect(
			checkVpeDom('<div id="close-to-a-level"><p>1 left: A</p></div>'),
		).toMatch(/does not say "Close to a level"/);
	});
});

const vpm = (inner: string) =>
	`<div id="guest-pipeline">${inner}</div><div class="qr">Invite to Invited to <a href="mailto:x@example.com">Email</a></div>`;
const INVITE = "<span>Invite to Tue, Sep 29</span>";
const INVITED = "<p>Invited to Tue, Sep 29 · by Sofia Reyes</p>";

describe("checkVpmDom", () => {
	it("passes with an invite control, an invited line and a draft link", () => {
		expect(
			checkVpmDom(
				vpm(`${INVITE}${INVITED}<a href="https://wa.me/12025550150?text=hi">WhatsApp</a>`),
			),
		).toBeNull();
		expect(
			checkVpmDom(vpm(`${INVITE}${INVITED}<a href="mailto:e@example.com">Email</a>`)),
		).toBeNull();
	});

	it("fails when the section is missing", () => {
		expect(checkVpmDom(`${INVITE}${INVITED}`)).toMatch(
			/no element with id="guest-pipeline"/,
		);
	});

	it("fails without an invite control", () => {
		expect(
			checkVpmDom(vpm(`${INVITED}<a href="mailto:e@example.com">Email</a>`)),
		).toMatch(/no "Invite to" control/);
	});

	it("fails without an invited line", () => {
		expect(
			checkVpmDom(vpm(`${INVITE}<a href="mailto:e@example.com">Email</a>`)),
		).toMatch(/no "Invited to" line/);
	});

	it("fails when no draft link rendered, i.e. the page never hydrated", () => {
		expect(checkVpmDom(vpm(`${INVITE}${INVITED}`))).toMatch(/had not hydrated/);
	});
});

describe("a rate-limited sign-in", () => {
	// What Chrome dumps when Better Auth answers the verify with a 429.
	const LIMITED =
		'<html><head></head><body><pre>{"message":"Too many requests. Please try again later."}</pre></body></html>';

	it("is named as such by both checks, not reported as a missing section", () => {
		expect(checkVpeDom(LIMITED)).toMatch(/rate-limited/);
		expect(checkVpmDom(LIMITED)).toMatch(/rate-limited/);
	});
});

describe("framingProblem", () => {
	const ok = { top: 96, viewportHeight: 900, headingVisible: true };

	it("passes a section at the top, uncovered", () => {
		expect(framingProblem("x", ok)).toBeNull();
		expect(framingProblem("x", { ...ok, top: 225 })).toBeNull();
	});

	it("fails a section below the top quarter, or scrolled past", () => {
		expect(framingProblem("x", { ...ok, top: 226 })).toMatch(/outside the top quarter/);
		expect(framingProblem("x", { ...ok, top: -10 })).toMatch(/outside the top quarter/);
	});

	it("fails a heading drawn under the sticky header", () => {
		expect(framingProblem("x", { ...ok, headingVisible: false })).toMatch(/drawn over its heading/);
	});

	it("fails when there is nothing to frame", () => {
		expect(framingProblem("x", null)).toMatch(/no element with id="x"/);
	});
});
