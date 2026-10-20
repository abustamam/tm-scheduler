/**
 * The anonymisation guard (`fixtureViolations`) and the generator's anonymiser, attacked with
 * INVENTED pages (#1252). Nothing here is a real person, club or number: names are made up, phones
 * are in the fictional 555-01xx range. Every probe is a way real data could have slipped through
 * once; each must now be caught. The guard is a net, not a gate: a human still reads the output.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isContactPage } from "./easy-speak-bundle";
import { FAKE_NAMES, fixtureViolations, readFixture } from "./easy-speak-test-kit";
import { FIXTURE_DIR, anonymise, main as fixtureCli } from "../scripts/easy-speak-fixture-from-archive";

const OK = `<html><body><a href="/profile.php?mode=viewprofile&u=900001">Avery Alderfinch</a><p>Our next speaker grows tomatoes.</p></body></html>`;
const withBody = (extra: string) => OK.replace("</body>", `${extra}</body>`);
const original = { clubIds: ["31415"], names: ["Riley Moonstone"], terms: ["Lakeside Mock"], personIds: ["123456"] };

describe("fixtureViolations: the baseline", () => {
	it("passes a clean page", () => {
		expect(fixtureViolations(OK)).toEqual([]);
		expect(fixtureViolations(OK, { original })).toEqual([]);
	});

	it("the committed pages all pass; only the two contact pages may carry a phone", () => {
		const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".html"));
		expect(files.length).toBeGreaterThan(5);
		for (const f of files) {
			const contact = f === "club-data.html" || f === "member-list.html";
			expect(fixtureViolations(readFixture(f), { contactPage: contact }), f).toEqual([]);
		}
	});
});

/** [label, page, what the complaint says]: each one is real data the guard once let through. */
const probes: [string, string, RegExp][] = [
	["a fake-range phone on a page that is not a contact page", withBody("<p>(555) 010-0001</p>"), /contact page/],
	["a phone with no separators", withBody("<p>2125550142</p>"), /phone/],
	["a tel: link", withBody('<a href="tel:+12125550142">call</a>'), /phone/],
	["a tel: link, entity-encoded digits", withBody('<a href="tel:&#50;125550142">call</a>'), /phone/],
	["an email with an entity-encoded @ (&#64;)", withBody("<p>jordan&#64;example.com</p>"), /email/],
	["an email with &commat;", withBody("<p>jordan&commat;example.com</p>"), /email/],
	["a username followed by &#160;", withBody("<p>[jtest]&#160;</p>"), /username "jtest"/],
	["a username followed by a space", withBody("<p>[jtest] here</p>"), /username "jtest"/],
	["a username with a hyphen", withBody("<p>[j-test]&nbsp;</p>"), /username "j-test"/],
	["an id under user_id=", withBody('<img src="/p.php?user_id=123456">'), /123456/],
	["an id under uid=", withBody('<a href="/x.php?uid=123456">x</a>'), /123456/],
	["a percent-encoded id", withBody('<img src="/p.php?a=1%26u%3D123456">'), /123456/],
	["a name only in a data- attribute", withBody('<div data-who="Jordan Testwright"></div>'), /Jordan Testwright/],
	["a name only in an href", withBody('<a href="/x.php?name=Jordan%20Testwright">x</a>'), /Jordan Testwright/],
	["a name only in an onclick", withBody("<a href=\"#\" onclick=\"go('Jordan+Testwright')\">x</a>"), /Jordan Testwright/],
];

describe("fixtureViolations: negative probes (synthetic pages that must be refused)", () => {
	it.each(probes)("refuses %s", (_label, html, complaint) => {
		expect(fixtureViolations(html).join("\n")).toMatch(complaint);
	});

	it("a phone on a contact page is allowed, if it is in the fake range", () => {
		expect(fixtureViolations(withBody("<p>(555) 010-0001</p>"), { contactPage: true })).toEqual([]);
		expect(fixtureViolations(withBody("<p>2125550142</p>"), { contactPage: true }).join()).toMatch(/phone/);
	});

	const originals: [string, string][] = [
		["a club id under any parameter name", '<a href="/v.php?club=31415">x</a>'],
		["a club id in single quotes", "<input name=cached_club value='31415'>"],
		["a value-first club id", '<input value="31415" name="cached_club">'],
		["a percent-encoded club id", '<a href="/v.php?a=1%26c%3D31415">x</a>'],
		["the real person's bare first name", "<p>Riley said hello</p>"],
		["the real person's bare surname, any case", "<p>MOONSTONE</p>"],
		["the real name with a plus for the space", '<a href="/s.php?n=Riley+Moonstone">x</a>'],
		["a club term, any case, in an attribute", '<div title="LAKESIDE MOCK club"></div>'],
		["a real person id under any parameter name", '<a href="/x.php?member_id=123456">x</a>'],
	];
	it.each(originals)("refuses a page that still carries the original: %s", (_label, extra) => {
		expect(fixtureViolations(withBody(extra), { original }), extra).not.toEqual([]);
	});
});

describe("anonymise: an invented page with every variant", () => {
	const raw = `<!DOCTYPE html><html><body>
<td><a href="https://easy-speak.org/profile.php?mode=editprofile">Welcome back Jordan Testwright</a>&nbsp;[j-test]&#160;</td>
<a href="/view_meeting.php?c=31415&amp;show=next">Lakeside Mock</a>
<a href="/v.php?club=31415">x</a> <input name=cached_club value='31415'> <input value="31415" name="cached_club"> <a href="/v.php?a=1%26c%3D31415">x</a>
<a href="/profile.php?mode=viewprofile&amp;u=123456">Jordan Testwright, DTM</a>
<a href="/profile.php?mode=viewprofile&amp;u=123456">J. Testwright</a>
<a href="/profile.php?mode=viewprofile&amp;u=123457">Sam Fairweather</a>
<img src="/photo.php?user_id=123456"> <img src="/p.php?a=1%26uid%3D123457"> <a href="/x.php?member_id=123457">x</a>
<p>Jordan said hello; later Testwright, Jordan spoke. Riley Moonstone grows tomatoes and Riley is new.</p>
<p>2125550142 (212) 555-0143 212.555.0144 <a href="tel:+12125550145">call</a></p>
<p>jordan&#64;example.com jo&commat;example.com <a href="mailto:jo@example.com">mail</a></p>
<p>[sam]&nbsp;[s-m] </p>
<div data-who="Jordan Testwright" title="Lakeside Mock"></div>
</body></html>`;
	const run = (page = raw, contactPage = true) => anonymise(page, { names: ["Riley Moonstone"], terms: ["Lakeside Mock"], clubIds: ["31415"], contactPage });

	it("leaves nothing real and passes the guard", () => {
		const { html, problems } = run();
		expect(problems).toEqual([]);
		for (const gone of ["Jordan", "Testwright", "Fairweather", "Moonstone", "Riley", "Sam", "Lakeside", "31415", "123456", "123457", "j-test", "s-m", "[sam]", "212", "0142", "0145", "@", "mailto", "tel:+1"]) {
			expect(html.toLowerCase(), gone).not.toContain(gone.toLowerCase());
		}
		expect(html).toContain("c=4242");
		expect(html).toContain("club=4242");
	});

	it("maps one person shown as a full name and as an initial to ONE fake name", () => {
		const { html } = run();
		const linkTexts = [...html.matchAll(/u=900001[^>]*>([^<]*)</g)].map((m) => m[1]);
		expect(linkTexts).toHaveLength(2);
		expect(new Set(linkTexts).size).toBe(1);
		expect(FAKE_NAMES).toContain(linkTexts[0]);
	});

	it("refuses a non-contact page that carries a phone", () => {
		expect(run(raw, false).problems.join("\n")).toMatch(/contact page/);
	});

	it("is not defeated by a person id nobody linked", () => {
		const { html, problems } = anonymise(`<img src="/p.php?user_id=555666">`, { clubIds: [] });
		expect(problems).toEqual([]);
		expect(html).not.toContain("555666");
		expect(html).toContain("user_id=9000");
	});

	it("refuses (and says so) when there are more people than ids, and more than fake names", () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/profile.php?mode=viewprofile&u=${200000 + i}">Person${"ab"[i % 2]} Name${String.fromCharCode(97 + (i % 26))}${i}</a>`).join("");
		expect(anonymise(many(1000)).problems.join("\n")).toMatch(/more people than the 900001-900999/);
		expect(anonymise(many(FAKE_NAMES.length + 1)).problems.join("\n")).toMatch(/than fake names/);
	});
});

describe("the command, the branches the other tests skip", () => {
	const dir = mkdtempSync(join(tmpdir(), "es-guard-"));
	const archive = join(dir, "easy-speak-1-2026-10-19-pages.json");
	const page = `<html><body><a href="/profile.php?mode=viewprofile&u=123456">Jordan Testwright</a><a href="/view_meeting.php?c=31415&show=next">x</a></body></html>`;
	writeFileSync(
		archive,
		JSON.stringify({
			format: "gavelup.easy-speak-pages",
			version: 1,
			exportedAt: "",
			club: { esClubId: "31415", number: null },
			pages: [{ url: "https://easy-speak.org/view_meeting.php?t=1", fetchedAt: "", html: page }],
		}),
	);
	const quiet = (fn: () => number) => {
		const [e, l] = [console.error, console.log];
		console.error = () => {};
		console.log = () => {};
		try {
			return fn();
		} finally {
			console.error = e;
			console.log = l;
		}
	};

	it("writes a passing page to the output directory, then refuses to overwrite it", () => {
		const outDir = mkdtempSync(join(tmpdir(), "es-out-"));
		try {
			expect(quiet(() => fixtureCli([archive, "--page", "0", "--out", "regression.html"], outDir))).toBe(0);
			const written = readFileSync(join(outDir, "regression.html"), "utf8");
			expect(written).not.toMatch(/Jordan|Testwright|31415|123456/);
			expect(fixtureViolations(written, { contactPage: isContactPage("https://easy-speak.org/view_meeting.php?t=1") })).toEqual([]);
			expect(quiet(() => fixtureCli([archive, "--page", "0", "--out", "regression.html"], outDir))).toBe(1);
			expect(readdirSync(outDir)).toEqual(["regression.html"]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
