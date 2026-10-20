/**
 * The fixture generator (#1272), attacked with INVENTED pages. Nothing here is a real person, club or
 * number: names are made up and phones are in ranges reserved for fiction. Each probe is a shape of
 * real data an earlier regex-based rewriter let through; the generated page must carry none of the
 * invented values. The generator is safe by construction (it replaces everything not on an
 * allow-list), and a human still reads the output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOW_LIST, generateFixture, newRewriteState, rewriteEasySpeakPage } from "../scripts/easy-speak-fixture-from-archive";
import { FAKE_NAMES, fixturePath, fixtureViolations, parseHtml, readFixture, setup, stripClock } from "./easy-speak-test-kit";

const SCRIPT = fileURLToPath(new URL("../scripts/easy-speak-fixture-from-archive.ts", import.meta.url));

const page = (body: string, head = "") =>
	`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Lakeside Mock Speakers :: View agenda</title>${head}</head><body>${body}</body></html>`;

/** The text a reader sees plus every attribute value, decoded, lower-cased: where an invented value could still be. */
function everything(html: string): string {
	const doc = parseHtml(html);
	const parts: string[] = [];
	const walk = (n: Node) => {
		if (n.nodeType === 3 || n.nodeType === 8) parts.push(n.nodeValue ?? "");
		if (n.nodeType === 1) for (const a of Array.from((n as Element).attributes ?? [])) parts.push(a.name, a.value);
		for (const c of Array.from(n.childNodes ?? [])) walk(c);
	};
	if (doc.documentElement) walk(doc.documentElement);
	const raw = `${html}\n${parts.join("\n")}`;
	let decoded = raw;
	for (let i = 0; i < 3; i++) {
		try {
			decoded = decodeURIComponent(decoded.replace(/\+/g, " "));
		} catch {
			break;
		}
	}
	return `${raw}\n${decoded}`.toLowerCase();
}

/** Throws with the value, so a failure names what leaked. */
function expectNone(html: string, values: string[]) {
	const hay = everything(html);
	for (const v of values) expect(hay.includes(v.toLowerCase()), `"${v}" is still in the generated page`).toBe(false);
}

describe("leak shapes: every invented value is gone", () => {
	it("the profile-link username, and a header naming the viewer", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<table class="toprow"><tr><td><a href="https://easy-speak.org/profile.php?mode=editprofile">Welcome back Marlowe Pennyfeather</a>&nbsp;[mpenny.f]&nbsp;</td></tr></table>` +
					`<span class="name">Welcome <a href="https://easy-speak.org/profile.php?mode=editprofile">mpenny.f</a><br></span>`,
			),
		);
		expectNone(out, ["marlowe", "pennyfeather", "mpenny"]);
		expect(fixtureViolations(out)).toEqual([]);
		expect(parseHtml(out).querySelector("span.name a")?.textContent).toBe("fixtureuser");
	});

	it("[user] directly before a closing tag; usernames containing a dot, hyphen or apostrophe", () => {
		const out = rewriteEasySpeakPage(page(`<b>[k.o'brien-1]</b><td>[quill.wick]</td><p>[ab]</p><i>[Show]</i>`));
		expectNone(out, ["k.o'brien", "quill.wick", "[ab]"]);
		expect(out).toContain("[Show]");
		expect(out).toContain("[fixtureuser]");
	});

	it("a real first name or surname that is also inside a fake name or an allowed phrase", () => {
		// "Hollowby" is a fake surname, "Avery" a fake first name; "Member" and "Timer" are allowed phrases.
		const out = rewriteEasySpeakPage(
			page(`<td>Avery Hollowby</td><td>Quillon Member</td><td>Timer Quillon</td><td>Toastmaster Orsino Vale</td><td>Avery Alderfinch Orsino</td>`),
		);
		expectNone(out, ["avery hollowby", "quillon", "orsino"]);
		expect(fixtureViolations(out, { original: { names: ["Avery Hollowby", "Quillon Member", "Orsino Vale"] } })).toEqual([]);
	});

	it("an allowed phrase in the next text node does not keep half of a split name", () => {
		const out = rewriteEasySpeakPage(page(`<td>Quillon <b>Timer</b></td><td><b>Timer</b> Quillon</td><td>Online <i>Quillon</i></td>`));
		expectNone(out, ["quillon"]);
		// "Timer" and "Online" are allowed on their own, not as half of a person's name
		for (const td of Array.from(parseHtml(out).querySelectorAll("td"))) expect(td.textContent, td.innerHTML).not.toMatch(/Timer|Online/);
		// and nothing is lost where the phrase stands alone
		expect(rewriteEasySpeakPage(page(`<td><b>Timer</b></td>`))).toContain("<b>Timer</b>");
	});

	it("name tokens shorter than three letters", () => {
		const out = rewriteEasySpeakPage(page(`<td>Bo Li</td><td>Ng</td><td>J. Qx</td><td>Yu Zi-Wen</td>`));
		const words = everything(out).match(/[a-z]+/g) ?? [];
		for (const w of ["bo", "li", "ng", "qx", "yu", "zi", "wen"]) expect(words, w).not.toContain(w);
	});

	it("names inside data-*, href, onclick, id and title; URL-encoded, lower-case and CamelCase copies", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<div data-who="Marlowe Pennyfeather" id="row_Marlowe_Pennyfeather" title="Marlowe Pennyfeather"></div>` +
					`<a href="/x.php?name=Marlowe%20Pennyfeather&q=marlowe+pennyfeather&k=1">x</a>` +
					`<a href="#" onclick="go('Marlowe+Pennyfeather');open('/profile.php?who=MarlowePennyfeather')">y</a>` +
					`<img src="/images/MarlowePennyfeather.gif" alt="marlowepennyfeather"><div data-k="marlowepennyfeather" class="marlowe"></div>` +
					`<a href="https://pennyfeather.example.com/marlowe">z</a>`,
			),
		);
		expectNone(out, ["marlowe", "pennyfeather"]);
		// the parameter NAMES are replaced too: a name can be one
		expect(out).toContain('href="/x?x=x&amp;x=x&amp;k=1"');
	});

	it("a venue named in a map link, a mailto: link, code that names someone, a text field", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="https://easy-speak.org/portal.php?page=4&amp;n=Quillon%20Hall&amp;s=1">map</a><a href="mailto:rowan@example.org">m</a>` +
					`<a href="#" onclick="showQuillonVale('x')">c</a><input name="note" value="Quillon Vale"><td>ID 4455</td><td>ref 123456</td>`,
			),
		);
		expectNone(out, ["quillon", "rowan", "4455", "123456"]);
		expect(parseHtml(out).querySelectorAll("a")[1].getAttribute("href")).toBe("#");
		expect(out).toContain("portal.php?page=4&amp;n=");
	});

	it("a surname that is also a month is replaced; a month inside an option stays", () => {
		const out = rewriteEasySpeakPage(page(`<td>May</td><td>June</td><select><option>May</option><option>June</option></select>`));
		expect(parseHtml(out).querySelectorAll("td").length).toBe(2);
		for (const td of Array.from(parseHtml(out).querySelectorAll("td"))) expect(td.textContent).not.toMatch(/May|June/);
		expect(out).toContain("<option>May</option>");
	});

	it("a name written with entities is one fake name, not three", () => {
		const out = rewriteEasySpeakPage(page(`<td>Ren&eacute; Dup&oacute;nt</td>`));
		expect(FAKE_NAMES).toContain(parseHtml(out).querySelector("td")?.textContent ?? "");
	});

	it("UK, Australian and 7-digit local phones; en-dash and non-breaking-hyphen separators; a number starting with 0", () => {
		const phones = [
			"+44 20 7946 0123",
			"(02) 5550 1234",
			"555-0198",
			"020‑7946‑0123",
			"415–555–0132",
			"0412 345 678",
			"+61 4 1234 5678",
			"(415) 555-0132",
			"02079460123",
		];
		const out = rewriteEasySpeakPage(page(phones.map((p) => `<td>Call ${p} now</td>`).join("")));
		expectNone(out, ["7946", "5550", "0198", "0132", "345 678", "0412", "1234", "5678", "0123"]);
		// every one became a fake phone, none an id
		expect(out.match(/\(555\) 010-\d{4}/g)?.length).toBe(phones.length);
		expect(fixtureViolations(out, { contactPage: true })).toEqual([]);
	});

	it("a phone split by inline tags", () => {
		const out = rewriteEasySpeakPage(page(`<td><span>415</span>-<span>555</span>-<b>0199</b></td><td>(<i>212</i>) <b>555</b> <u>0147</u></td>`));
		expectNone(out, ["0199", "0147", "415", "212"]);
		expect(everything(out)).not.toMatch(/\b555\b(?!\) 010)/);
	});

	it("an email, with a numeric entity written without its semicolon", () => {
		const out = rewriteEasySpeakPage(page(`<p>quillon&#64example.org</p><p>quillon&commat;example.org</p><p>quillon@example.org</p><a href="mailto:quillon@example.org">m</a>`));
		expectNone(out, ["quillon", "example.org"]);
		expect(fixtureViolations(out)).toEqual([]);
	});

	it("a name split by an inline tag", () => {
		const out = rewriteEasySpeakPage(page(`<td>Marlowe <b>Pennyfeather</b></td><td><i>Pennyfeather</i>, <b>Marlowe</b></td>`));
		expectNone(out, ["marlowe", "pennyfeather"]);
	});

	it("accented names and named accented entities", () => {
		const out = rewriteEasySpeakPage(page(`<td>Ren&eacute; Dupónt</td><td>Zoë Café-Rousseau</td><td>&Aacute;ngel N&uacute;&ntilde;ez</td><td title="José Østergaard">x</td>`));
		expectNone(out, ["dup", "rousseau", "ngel", "ez", "stergaard", "ren", "zoë", "jos"]);
	});

	it("person ids under speaker=, id=, u=, a bare id in a path and form fields", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="https://easy-speak.org/request_speech.php?speaker=123456">a</a><a href="/x.php?id=345678">b</a><a href="/profile.php?mode=viewprofile&amp;u=234567">c</a>` +
					`<a href="/api/v1/evaluations.php/eval/456789">d</a>` +
					`<form><input type="hidden" name="cached_user" value="456789"><input name="speaker" value="567890"><input type="hidden" name="uid" value="678901"><input name="who" value="789012"><input type="radio" name="available[890123]" value="2"><input name="rec[901234]" value="901234"></form>` +
					`<img name="attend_image1[112233]"><label for="available_112233_p" id="available_112233_p"></label>`,
			),
		);
		expectNone(out, ["123456", "345678", "234567", "456789", "567890", "678901", "789012", "890123", "901234", "112233"]);
		expect(fixtureViolations(out)).toEqual([]);
		// the same real id is the same fake wherever it appears
		const ids = [...out.matchAll(/9000\d{2}/g)].map((m) => m[0]);
		expect(new Set(ids).size).toBeLessThan(ids.length);
	});

	it("zero-padded club numbers, and another club's id", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<form action="https://dashboards.toastmasters.org/ClubReport.aspx?id=00031415"></form>` +
					`<a href="https://easy-speak.org/view_meeting.php?c=27182&amp;show=next">own</a><a href="https://easy-speak.org/orgdata.php?c=00027182">own</a>` +
					`<a href="https://easy-speak.org/view_meeting.php?c=16180">other</a><a href="https://marshalls.org/tmtools/DCP_Hist.cgi?club=0031415&amp;mon=cur">h</a>` +
					`<table><tr><td>Club Number</td><td>031415</td></tr><tr><td>Club Number</td><td>12</td></tr></table><p>Club 00016180</p>`,
			),
		);
		expectNone(out, ["31415", "27182", "16180"]);
		// zero padding keeps its width, and one real club is one fake club
		expect(out).toMatch(/ClubReport\.aspx\?id=0000\d{4}/);
		const own = [...out.matchAll(/c=(\d+)/g)].map((m) => m[1]);
		expect(own[0].replace(/^0+/, "")).toBe(own[1].replace(/^0+/, ""));
	});

	it("a real club's name and places never survive, whatever its words", () => {
		const out = rewriteEasySpeakPage(page(`<td>Venue <b>Lakeside Mock Library, 12 Orchard Lane</b></td><td>Theme: Harvest Moon</td>`));
		expectNone(out, ["lakeside", "orchard", "harvest", "library"]);
	});

	it("script and style bodies, comments and unknown classes are emptied", () => {
		const out = rewriteEasySpeakPage(
			page(`<script>var who = "Marlowe Pennyfeather";</script><style>.marlowe{color:red}</style><!-- note about Marlowe --><!--start of Attendance--><p class="quillon gen">x</p>`),
		);
		expectNone(out, ["marlowe", "pennyfeather", "quillon"]);
		expect(out).toContain("start of Attendance");
		expect(out).toContain("<script></script>");
		expect(out).toContain('class="x gen"');
	});
});

describe("review round: every invented value is gone (#1275)", () => {
	it("1. URLs keep no subdomain, filename, parameter value, fragment or long number", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="https://rowan.toastmasters.org/members/Quillon_Brackenby.php?show=quillonb&amp;sort=brackenby&amp;mode=Quillon&amp;go=Quorvak&amp;s=quorvak#quillon_brackenby">a</a>` +
					`<a href="/x?t=74155501&amp;k=4155550&amp;r=4155551&amp;chart=4155552&amp;page=4155553&amp;ret=4155554&amp;z=4155555">b</a>` +
					`<a href="https://rowan.example.test/quillon/brackenby">c</a><a href="https://quorvak.easy-speak.org/profile.php?mode=viewprofile&amp;u=1">d</a>` +
					`<a href="/tm_all_speeches.php/Quillon/501/Rowan.gif">e</a>`,
			),
		);
		expectNone(out, ["rowan", "quillon", "brackenby", "quorvak", "74155501", "4155550", "4155551", "4155552", "4155553", "4155554", "4155555", "/501/"]);
		for (const a of Array.from(parseHtml(out).querySelectorAll("a"))) expect(a.getAttribute("href"), "no fragment survives").not.toMatch(/#./);
	});

	it("2. a comment or a doctype outside <html> is scrubbed too", () => {
		const out = rewriteEasySpeakPage(
			`<!-- rowan tidewell --><!DOCTYPE html PUBLIC "-//Zed Quorvak//EN" "http://quorvak.example/zed.dtd"><html><head></head><body><p>x</p></body></html>`,
		);
		expectNone(out, ["rowan", "tidewell", "zed", "quorvak"]);
		expect(fixtureViolations(out)).toEqual([]);
	});

	it("3. an attribute NAME can carry data; unknown names are renamed, even constructor and __proto__", () => {
		const out = rewriteEasySpeakPage(page(`<div data-rowan-tidewell="" data-person-123456="x" constructor="Quillon" __proto__="Quorvak" tostring="y"><rowan-tidewell>hi</rowan-tidewell></div>`));
		expectNone(out, ["rowan", "tidewell", "123456", "quillon", "quorvak"]);
		expect(fixtureViolations(out)).toEqual([]);
	});

	it("4. form values: the field name is read before it is rewritten, and a person id is one fake wherever it appears", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<form><input name="speech_owner" value="1234567"><input name="speech_note" value="0412345678"><input name="user" value="123"><input value="7654321" name="meeting_phone">` +
					`<input name="speaker" value="567890"><select name="speaker"><option value="567891">x</option><option value="567890">y</option></select>` +
					`<input name="cached_agenda" value="9988776"></form><a href="/profile.php?mode=viewprofile&amp;u=567890">n</a>`,
			),
		);
		expectNone(out, ["1234567", "0412345678", "7654321", "567890", "567891", "9988776"]);
		const doc = parseHtml(out);
		const link = /u=(\d+)/.exec(doc.querySelector("a")?.getAttribute("href") ?? "")?.[1];
		expect(link).toMatch(/^9000\d\d$/);
		expect(doc.querySelector('input[name="speaker"]')?.getAttribute("value")).toBe(link);
		expect(doc.querySelectorAll("option")[1].getAttribute("value")).toBe(link);
		expect(doc.querySelector('input[name="user"]')?.getAttribute("value")).toMatch(/^9000\d\d$/);
	});

	it("5. a phone split across block elements, written with slashes, or in a handler; a house number", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<div>415</div><div>555</div><div>0199</div><p>020/7946/0018</p><a href="#" onclick="go(212-555-0147)">x</a><table><tr><td>742 Quorvak Lane</td></tr></table>` +
					`<p>Call 618-555-0123</p>`,
			),
		);
		expectNone(out, ["0199", "7946", "0018", "0147", "742", "quorvak", "0123"]);
		const text = everything(out).replace(/\(555\) 010-\d{4}/g, "");
		expect(text).not.toMatch(/\b(?:415|020|212|618|555)\b/);
	});

	it("6. JS string escapes are decoded before the handler is scanned", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="#" onclick="alert('\\162\\157\\167\\141\\156\\100\\145\\170\\141\\155\\160\\154\\145\\056\\157\\162\\147')">a</a>` +
					`<a href="#" onclick="go('\\x72\\x6f\\x77\\x61\\x6e')">b</a><a href="#" onclick="go('\\u0072\\u006f\\u0077\\u0061\\u006e')">c</a><a href="#" onclick="go('\\u{72}\\u{6f}wan')">d</a>`,
			),
		);
		expectNone(out, ["rowan", "example.org"]);
		expect(out).not.toMatch(/\\[0-7xu]/);
		expect(fixtureViolations(out)).toEqual([]);
	});

	it("6b. a decoded escape is judged as what it spells: an escaped URL is rewritten as a URL, an escaped allowed phrase stays", () => {
		const out = rewriteEasySpeakPage(
			page(`<a href="#" onclick="go('\\x68ttps://easy-speak.org/profile.php?mode=viewprofile&u=123456')">a</a><a href="#" onclick="go('\\u0054imer')">b</a>`),
		);
		expect(out).toContain("https://easy-speak.org/profile.php?mode=viewprofile&amp;u=");
		expect(out).not.toContain("123456");
		expect(out).toContain("('Timer')");
		expect(fixtureViolations(out)).toEqual([]);
	});

	it("6c. a form value under an <option> is typed by its select's ORIGINAL name, even when that name is itself rewritten", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="https://easy-speak.org/profile.php?mode=viewprofile&amp;u=567890">Rowan Tidewell</a>` +
					`<select name="quillonuser"><option value="567890">x</option></select>`,
			),
		);
		const doc = parseHtml(out);
		const link = /u=(\d+)/.exec(doc.querySelector("a")?.getAttribute("href") ?? "")?.[1];
		expect(link).toBeTruthy();
		expect(doc.querySelector("option")?.getAttribute("value")).toBe(link);
	});

	it("6d. a query parameter named like an Object property does not throw and its value goes", () => {
		const out = rewriteEasySpeakPage(page(`<a href="/index.php?constructor=Quillon&amp;__proto__=Quorvak&amp;hasownproperty=Zed&amp;tostring=Eli">a</a>`));
		expectNone(out, ["Quillon", "Quorvak", "Zed", "Eli"]);
	});

	it("7. an allowed word does not survive next to a name, in another node, or inside a timezone", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<table><tr><td>Europe/Quillon_Brackenby</td><td>Asia/Rowanvale</td><td>America/Quorvak_Zed</td><td>Timer, Quillon</td><td>rowan Timer</td>` +
					`<td><a href="/profile.php?mode=viewprofile&amp;u=123456">Quillon</a> <b>Mentor</b></td><td>Eli <b>Page</b></td><td>Zed <b>M</b></td></tr></table>`,
			),
		);
		expectNone(out, ["quillon", "brackenby", "rowanvale", "quorvak", "zed", "eli", "rowan"]);
		const tds = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(tds[3], "Timer, Quillon").not.toContain("Timer");
		expect(tds[4], "rowan Timer").not.toContain("Timer");
		expect(tds[5], "linked name + Mentor").not.toContain("Mentor");
		expect(tds[6], "Eli Page").not.toContain("Page");
		expect(tds[7], "Zed M").not.toMatch(/(?:^|\s)M(?:\s|$)/);
	});

	it("8. a value that only resembles a fake is replaced like any other", () => {
		const phrases = JSON.parse(readFixture("non-person-phrases.json")) as { speechTitlesAndThemes: string[]; fixturePlaces: string[] };
		// the output draws its fakes from the front of the list, so names from the back cannot be one of them by chance
		const LATE = FAKE_NAMES.slice(-2);
		const title = phrases.speechTitlesAndThemes[0];
		const place = phrases.fixturePlaces[0];
		const out = rewriteEasySpeakPage(
			page(
				`<a href="/profile.php?mode=viewprofile&amp;u=900123">${LATE[0]}</a><table><tr><td>${LATE[1]}</td><td>${title}</td><td>${place}</td><td>(555) 010-0777</td><td>fixtureuser</td></tr></table>` +
					`<a href="/orgdata.php?c=9999">x</a><a href="/orgdata.php?c=4242">y</a><a href="/profile.php?mode=viewprofile&amp;u=900124">z</a>`,
			),
		);
		expectNone(out, ["900123", "900124", LATE[0], LATE[1], title, place, "0777", "c=9999", "fixtureuser"]);
		const clubs = [...out.matchAll(/c=(\d+)/g)].map((m) => m[1]);
		expect(new Set(clubs).size, "two real clubs are two fakes").toBe(2);
		expect(clubs[1], "the real 4242 is not passed through").not.toBe("4242");
	});

	it("9. a counter and a division are bounded: a long number or a word after the x or the Division is replaced", () => {
		const out = rewriteEasySpeakPage(page(`<table><tr><td>x741</td><td>Division Quillon</td><td>x6</td><td>Division B</td><td>Area 12</td></tr></table>`));
		expectNone(out, ["741", "quillon"]);
		const tds = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent);
		expect(tds.slice(2)).toEqual(["x6", "Division B", "Area 12"]);
	});

	it("10. entities are decoded, scrubbed and escaped again", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<textarea>Timer &amp; Speaker</textarea><table><tr><td>Tom &amp; Jerry &lt;3</td></tr></table>` +
					`<iframe srcdoc="&lt;p&gt;Hi Quillon &lt;b&gt;Timer&lt;/b&gt;&lt;/p&gt;"></iframe>`,
			),
		);
		expect(out).not.toMatch(/&redacted|&[a-z]+-\d/);
		expect(out).toContain("<textarea>Timer &amp; Speaker</textarea>");
		expect(parseHtml(out).querySelector("td")?.textContent).toMatch(/ & /);
		expectNone(out, ["quillon"]);
		const srcdoc = parseHtml(out).querySelector("iframe")?.getAttribute("srcdoc") ?? "";
		expect(srcdoc).toMatch(/<p>.*<b>.*<\/b>.*<\/p>/);
	});

	it("12. rel, http-equiv, a meta content type and the handler's own function names stay", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="#" onclick="window.open('profile.php?mode=miniprofile&amp;u=1', '_blank')">a</a><a href="javascript: showStatus('Visitor');">v</a>`,
				`<link rel="stylesheet" href="/images/x.css"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">`,
			),
		);
		expect(out).toContain('rel="stylesheet"');
		expect(out).toContain('http-equiv="Content-Type"');
		expect(out).toContain('content="text/html; charset=UTF-8"');
		expect(out).toContain("window.open('profile.php?mode=miniprofile&amp;u=900001', '_blank')");
		expect(out).toContain("showStatus('Visitor')");
	});

	it("A. a shared state gives a person the fake they already had; a fresh state does not", () => {
		const link = (u: string, who: string) => `<a href="/profile.php?mode=viewprofile&amp;u=${u}">${who}</a>`;
		const read = (html: string, i: number) => {
			const a = parseHtml(html).querySelectorAll("a")[i];
			return { name: a.textContent ?? "", id: /u=(\d+)/.exec(a.getAttribute("href") ?? "")?.[1] };
		};
		const st = newRewriteState();
		const page1 = rewriteEasySpeakPage(page(link("555111", "Rowan Tidewell") + link("555222", "Sloane Brightmere")), { state: st });
		const page2 = rewriteEasySpeakPage(page(link("555222", "Sloane Brightmere")), { state: st });
		const fresh = rewriteEasySpeakPage(page(link("555222", "Sloane Brightmere")), { state: newRewriteState() });
		expect(read(page1, 0)).not.toEqual(read(page1, 1));
		expect(read(page2, 0)).toEqual(read(page1, 1));
		expect(read(fresh, 0)).not.toEqual(read(page1, 1));
	});

	it("D. a surname Small is replaced as text, and <small> is left alone", () => {
		const out = rewriteEasySpeakPage(page(`<small>Small</small>`));
		const small = parseHtml(out).querySelector("small");
		expect(small).not.toBeNull();
		expect(small?.textContent).not.toBe("Small");
	});
});

describe("pages that must not be corrupted", () => {
	it('a surname "Small" leaves <small> intact', () => {
		const out = rewriteEasySpeakPage(page(`<td><small>Fine print</small> Priya Small</td><small>Small</small>`));
		expect(out).toContain("<small>");
		expect(out).toContain("</small>");
		expect(everything(out).replace(/<\/?small>/g, "")).not.toContain("priya");
	});

	it('a surname "May" leaves dates intact', () => {
		const out = rewriteEasySpeakPage(
			page(`<td class="maintitle">Tuesday 22nd September 2026 at 7:00 pm America/Los_Angeles</td><td>Noah May</td><td>May 2026</td><td>Sep 28 26, 2:43 pm</td><td>2025-05-05</td><td>(Actual meeting detail entered on 2026-10-01)</td>`),
		);
		expect(out).toContain("Tuesday 22nd September 2026 at 7:00 pm America/Los_Angeles");
		expect(out).toContain("May 2026");
		expect(out).toContain("Sep 28 26, 2:43 pm");
		expect(out).toContain("2025-05-05");
		expect(out).toContain("2026-10-01");
		expect(out).not.toMatch(/Noah|>May</);
	});

	it('a surname "Page" leaves ?page= and the pager intact', () => {
		const out = rewriteEasySpeakPage(
			page(`<a href="https://easy-speak.org/portal.php?page=4&amp;s=1">map</a><span class="nav">&nbsp;Page <b>1</b> of <b>3</b></span><td>Eli Page</td>`),
		);
		expect(out).toContain("portal.php?page=4&amp;s=1");
		expect(out).toContain("Page <b>1</b> of <b>3</b>");
		expect(out).not.toContain("Eli");
		expect(everything(out)).not.toMatch(/>page</);
	});

	it("a person's fake is the same in a link and a table, and a name that looks like a fake is replaced like any other", () => {
		// the generator hands out fakes from the front of the list, so a name from the back is "a fake by chance" only if it is trusted
		const looksFake = FAKE_NAMES[FAKE_NAMES.length - 3];
		const out = rewriteEasySpeakPage(
			page(
				`<a href="https://easy-speak.org/profile.php?mode=viewprofile&amp;u=555111">Rowan Tidewell, DTM</a><td>Rowan Tidewell</td>` +
					`<a href="https://easy-speak.org/profile.php?mode=viewprofile&amp;u=555222">Sloane Brightmere</a><td>${looksFake}</td>`,
			),
		);
		const links = Array.from(parseHtml(out).querySelectorAll("a")).map((a) => a.textContent ?? "");
		const cells = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(links[0].replace(/, DTM$/, "")).toBe(cells[0]);
		// nothing is trusted for resembling a fake: a fake-looking name was on the page, so it is rewritten too
		expect(out).not.toContain(looksFake);
		expect(new Set([links[0].replace(/, DTM$/, ""), links[1], cells[1]]).size).toBe(3);
		expect(out).toContain(", DTM");
		expect(fixtureViolations(out)).toEqual([]);
	});

	it("keeps a Venue label and a level, so the page still parses", () => {
		const out = rewriteEasySpeakPage(page(`<span class="gen">Venue&#160;<b><a href="javascript: void(0);">Quillon Hall</a></b></span><td>#2-1 - Effective Quillon</td><td>2 - Humor of Rowan</td>`));
		expect(out).toContain("Venue");
		expect(out).not.toContain("Quillon Hall");
		const tds = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(tds[0]).toMatch(/^#2-1 - /);
		expect(tds[1]).toMatch(/^2 - /);
		expect(out).not.toMatch(/Quillon|Rowan/);
	});

	it("keeps tags, tag names and attribute names exactly", () => {
		const html = page(`<table class="forumline"><tbody><tr><td colspan="3" class="row1"><span class="gen">Toastmaster</span></td></tr></tbody></table>`);
		const tags = (h: string) => [...parseHtml(h).querySelectorAll("*")].map((e) => `${e.tagName}:${Array.from(e.attributes).map((a) => a.name).join(",")}`);
		expect(tags(rewriteEasySpeakPage(html))).toEqual(tags(html));
	});

	it("is deterministic and idempotent: a second pass changes nothing", () => {
		const html = page(`<a href="/profile.php?mode=viewprofile&amp;u=555111">Rowan Tidewell</a><td>Sloane Brightmere</td>`);
		expect(rewriteEasySpeakPage(html)).toBe(rewriteEasySpeakPage(html));
		const once = rewriteEasySpeakPage(html);
		expect(rewriteEasySpeakPage(once)).toBe(once);
	});

	it("a run can share its state across pages, so a person keeps one fake", () => {
		const st = newRewriteState();
		const a = rewriteEasySpeakPage(page(`<a href="/profile.php?mode=viewprofile&amp;u=555111">Rowan Tidewell</a>`), { state: st });
		const b = rewriteEasySpeakPage(page(`<a href="/profile.php?mode=viewprofile&amp;u=555111">Rowan Tidewell</a>`), { state: st });
		expect(a).toBe(b);
	});
});

describe("the allow-list", () => {
	it("no string anywhere in the list is a fake name, a word of one, or a plausible surname that is also a date or a common word", () => {
		const strings: string[] = [];
		const walk = (v: unknown, key: string) => {
			if (key === "shapes" || key === "windowFeatures") return; // regex sources, not words
			if (typeof v === "string") strings.push(v);
			else if (Array.isArray(v)) for (const x of v) walk(x, key);
			else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
		};
		walk(ALLOW_LIST, "");
		expect(strings.length).toBeGreaterThan(200);
		const fakeWords = new Set(FAKE_NAMES.filter((n) => !n.startsWith("Guest ")).flatMap((n) => n.split(/\s+/)));
		for (const p of strings) {
			expect(p, "an empty string matches everything").not.toBe("");
			expect(FAKE_NAMES, p).not.toContain(p);
			expect(fakeWords.has(p), `${p} is a word of a fake name`).toBe(false);
		}
		for (const w of ["May", "Page", "Small", "March", "August", "April", "June"]) expect(ALLOW_LIST.phrases, w).not.toContain(w);
		expect(new Set(ALLOW_LIST.phrases).size).toBe(ALLOW_LIST.phrases.length);
	});

	it("names the structural strings a reviewer expects", () => {
		for (const p of ["Toastmaster", "Table Topic Master", "Total Attendance", "Did NOT Attend", "Club Number"]) expect(ALLOW_LIST.phrases).toContain(p);
		expect(ALLOW_LIST.classes).toContain("forumline");
	});
});

describe("the committed fixtures round-trip", () => {
	const files = readdirSync(fixturePath("")).filter((f) => f.endsWith(".html"));
	const isContact = (f: string) => f === "club-data.html" || f === "member-list.html";
	const base26 = (n: number) => {
		let s = "";
		let k = n;
		do {
			s = String.fromCharCode(97 + (k % 26)) + s;
			k = Math.floor(k / 26);
		} while (k > 0);
		return s.padStart(3, "a");
	};
	const phrases = JSON.parse(readFixture("non-person-phrases.json")) as { fixturePlaces: string[]; speechTitlesAndThemes: string[] };

	/**
	 * The committed pages are already fake, so running the generator over them proves nothing (an identity
	 * function passes). This puts INVENTED real-looking values back in first: every fake name, person id, club
	 * id and number, phone, username, place, speech title and the join host become a made-up one, and the
	 * generator must remove every one of them.
	 */
	function deFake(html: string) {
		let out = html;
		const names: string[] = [];
		[...FAKE_NAMES]
			.map((n, i) => ({ n, i }))
			.sort((a, b) => b.n.length - a.n.length)
			.forEach(({ n, i }) => {
				const b = base26(i);
				const invented = `Zq${b}ovak Brack${b}enby`;
				if (out.includes(n)) names.push(invented);
				out = out.replaceAll(n, invented);
			});
		const terms = ["zorvakuser", "quorvakclub.zoom.us", "quorvakroom"];
		out = out
			.replaceAll("fixtureuser", "zorvakuser")
			.replaceAll("fixture-speakers.example.test", "quorvakclub.zoom.us")
			.replaceAll("/join/fixture", "/join/quorvakroom")
			.replace(/\b900(\d{3})\b/g, "7900$1")
			.replace(/(?<!\d)4242(?!\d)/g, "7314159")
			.replace(/(?<![1-9])(0*)9999(?!\d)/g, "$12718281")
			.replace(/\(555\) 010-(\d{4})/g, "(212) 555-$1");
		[...phrases.fixturePlaces, ...phrases.speechTitlesAndThemes]
			.sort((a, b) => b.length - a.length)
			.forEach((p, i) => {
				const invented = `zq${base26(i)} glen`;
				if (out.includes(p)) terms.push(invented);
				out = out.replaceAll(p, invented);
			});
		return { html: out, names, terms };
	}
	const original = (names: string[], terms: string[]) => ({ names, terms, clubIds: ["7314159", "2718281"], personIds: [] as string[] });

	it.each(files)("%s: invented real values put back in are all gone, and the structure is the page's own", (f) => {
		const d = deFake(readFixture(f));
		const r = generateFixture(d.html, { contactPage: isContact(f), original: original(d.names, d.terms) });
		expect(r.violations).toEqual([]);
		expectNone(r.html, [...d.names, ...d.terms]);
		expect(r.html).not.toMatch(/7900\d{3}|7314159|2718281|\(212\) 555-/);
		const tags = (h: string) => [...parseHtml(h).querySelectorAll("*")].map((e) => e.tagName);
		expect(tags(r.html)).toEqual(tags(readFixture(f)));
	});

	it("the net sees what the rewrite missed: an identity rewrite of the de-faked pages is reported", () => {
		// the guard of the round-trip above: were the generator a no-op, the second net would name the leftovers
		for (const f of ["meeting-list.html", "club-data.html"]) {
			const d = deFake(readFixture(f));
			expect(fixtureViolations(d.html, { contactPage: isContact(f), original: original(d.names, d.terms) }).length, f).toBeGreaterThan(0);
		}
	});

	/** The strings a rewrite replaces on purpose: a theme, a title, an introduction are the club's own words. */
	const FREE_TEXT = new Set(["theme", "wordOfTheDay", "title", "introduction", "topic", "joinUrl", "project", "path", "venue"]);
	/** The bundle with free text blanked and every name and long number replaced by the order it first appears in: two bundles are the same structure if these are equal. */
	function canon(bundle: unknown): string {
		const seen = new Map<string, string>();
		const tok = (m: string) => {
			let t = seen.get(m);
			if (!t) {
				t = `<${seen.size}>`;
				seen.set(m, t);
			}
			return t;
		};
		const blank = (v: unknown, key = ""): unknown => {
			// evaluations come from the committed JSON files, which the generator does not rewrite, so only their count is compared
			if (key === "evaluations" && Array.isArray(v)) return v.length;
			if (Array.isArray(v)) return v.map((x) => blank(x, key));
			if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "club" ? { ...(x as object), name: "*" } : blank(x, k)]));
			return typeof v === "string" && FREE_TEXT.has(key) ? "*" : v;
		};
		const names = new RegExp([...FAKE_NAMES].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
		return JSON.stringify(blank(bundle)).replace(names, tok).replace(/\d{4,}/g, tok);
	}

	it("the walk still runs, and finds the same meetings, people, roles, speeches and dates, with every id and person lining up across the rewritten pages", async () => {
		const st = newRewriteState();
		// the walker is signed in as the fixture club (4242); the de-faked club id's fake is that one
		st.numbers.set("7314159", "4242");
		st.nextNumber = 4243;
		const generated = new Map<string, string>();
		for (const f of ["club-data.html", ...files.filter((x) => x !== "club-data.html")]) {
			const r = generateFixture(deFake(readFixture(f)).html, { contactPage: isContact(f), state: st });
			expect(r.violations, f).toEqual([]);
			generated.set(f, r.html);
		}
		const fake = (real: string) => st.numbers.get(real);
		const extraMeetings: Record<string, string> = {};
		for (const [id, file] of [["644360", "meeting-upcoming.html"], ["644304", "meeting-completed.html"], ["644363", "meeting-table-topics.html"]]) {
			const f = fake(id);
			if (f) extraMeetings[f] = file;
		}
		const introId = fake("1473688");
		const plain = stripClock(await setup().run()).bundle;
		const again = stripClock(
			await setup({
				read: (name) => generated.get(name) ?? readFixture(name),
				extraMeetings,
				override: (url) => {
					const u = new URL(url);
					return u.pathname === "/request_speech.php" && introId && u.searchParams.get("s") === introId ? generated.get("speech-request-intro.html") : undefined;
				},
			}).run(),
		).bundle;
		expect(again.meetings.length).toBe(plain.meetings.length);
		expect(again.people.length).toBe(plain.people.length);
		expect(canon(again)).toBe(canon(plain));
	});
});

describe("the second net with the real values", () => {
	it("generateFixture reports a real term that survives the rewrite", () => {
		// "Timer" is an allowed phrase, so it is kept; told it is somebody's real value, the net must say so
		const r = generateFixture(page(`<td>Timer</td>`), { original: { terms: ["Timer"] } });
		expect(r.html).toContain("Timer");
		expect(r.violations.length).toBeGreaterThan(0);
		expect(r.violations.join("\n")).toMatch(/Timer/);
	});

	it("generateFixture is clean when the real value did not survive", () => {
		const r = generateFixture(page(`<td>Rowan Tidewell</td>`), { original: { names: ["Rowan Tidewell"], terms: ["Tidewell"] } });
		expect(r.violations).toEqual([]);
	});
});

describe("the command", () => {
	const dir = mkdtempSync(join(tmpdir(), "es-fixture-"));
	const run = (args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });

	it("writes a page that passes, and tells the human to read it", () => {
		const input = join(dir, "ok.html");
		const out = join(dir, "ok-out.html");
		writeFileSync(input, page(`<td>Rowan Tidewell</td>`));
		const r = run([input, out]);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Read every line/);
		expect(existsSync(out)).toBe(true);
		expect(readFileSync_(out)).not.toMatch(/Rowan|Tidewell/);
	});

	it("writes NOTHING and exits non-zero when the output would fail fixtureViolations", () => {
		// A phone on a page that is not a contact page is a violation however it is faked.
		const input = join(dir, "bad.html");
		const out = join(dir, "bad-out.html");
		writeFileSync(input, page(`<td>Call 415 555 0132</td>`));
		const r = run([input, out]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/Nothing written/);
		expect(r.stderr).toMatch(/phone/);
		expect(existsSync(out)).toBe(false);
	});

	it("takes a page out of the export's archive by url, and refuses an ambiguous one", () => {
		const archive = join(dir, "pages.json");
		writeFileSync(
			archive,
			JSON.stringify({ pages: [{ url: "https://easy-speak.org/a.php", html: page("<td>Rowan Tidewell</td>") }, { url: "https://easy-speak.org/b.php", html: page("<td>x</td>") }] }),
		);
		const out = join(dir, "arch-out.html");
		expect(run(["--archive", archive, "--page", "a.php", out]).status).toBe(0);
		expect(existsSync(out)).toBe(true);
		const none = join(dir, "arch-none.html");
		expect(run(["--archive", archive, "--page", "easy-speak.org", none]).status).not.toBe(0);
		expect(existsSync(none)).toBe(false);
	});

	it("exits non-zero and writes nothing when a --real-term survives the rewrite", () => {
		const input = join(dir, "term.html");
		const out = join(dir, "term-out.html");
		writeFileSync(input, page(`<td>Timer</td>`));
		const r = run([input, out, "--real-term", "Timer"]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/Nothing written/);
		expect(existsSync(out)).toBe(false);
	});

	it("passes the real values it was told about to the second net", () => {
		// Nothing of "Rowan" can survive the rewrite, so this passes; the flag is wired if the run accepts it.
		const input = join(dir, "orig.html");
		const out = join(dir, "orig-out.html");
		writeFileSync(input, page(`<td>Rowan Tidewell</td>`));
		expect(run([input, out, "--real-name", "Rowan Tidewell", "--real-club", "31415"]).status).toBe(0);
	});
});

import { readFileSync } from "node:fs";
const readFileSync_ = (p: string) => readFileSync(p, "utf8");
