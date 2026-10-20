/**
 * The anonymisation guard (`fixtureViolations`), attacked with
 * INVENTED pages (#1252). Nothing here is a real person, club or number: names are made up, phones
 * are in the fictional 555-01xx range. Every probe is a way real data could have slipped through
 * once; each must now be caught. The guard is a net, not a gate: a human still reads the output.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixturePath, fixtureViolations, readFixture } from "./easy-speak-test-kit";

const OK = `<html><body><a href="/profile.php?mode=viewprofile&u=900001">Avery Alderfinch</a><p>Our next speaker grows tomatoes.</p></body></html>`;
const withBody = (extra: string) => OK.replace("</body>", `${extra}</body>`);
const original = { clubIds: ["31415"], names: ["Riley Moonstone"], terms: ["Lakeside Mock"], personIds: ["123456"] };

describe("fixtureViolations: the baseline", () => {
	it("passes a clean page", () => {
		expect(fixtureViolations(OK)).toEqual([]);
		expect(fixtureViolations(OK, { original })).toEqual([]);
	});

	it("the committed pages all pass; only the two contact pages may carry a phone", () => {
		const files = readdirSync(fixturePath("")).filter((f) => f.endsWith(".html"));
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
