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
import { ALLOW_LIST, generateFixture, newRewriteState, presetNumber, primeRewriteState, rewriteEasySpeakPage } from "../scripts/easy-speak-fixture-from-archive";
import { clock, FAKE_FIRSTS, FAKE_LASTS, FAKE_NAMES, fixturePath, fixtureViolations, isFakeName, parseHtml, readFixture, setup, stripClock } from "./easy-speak-test-kit";

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
		expect(out).toMatch(/href="\/x\?x=x&amp;x=x&amp;k=\d+"/);
		expect(out).not.toContain("k=1\"");
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
		expect(out).toMatch(/portal\.php\?page=\d&amp;n=/);
		expect(out).not.toContain("page=4");
	});

	it("a surname that is also a month is replaced; a month inside an option stays", () => {
		const out = rewriteEasySpeakPage(page(`<td>May</td><td>June</td><select name="start_month"><option>May</option><option>June</option></select>`));
		expect(parseHtml(out).querySelectorAll("td").length).toBe(2);
		for (const td of Array.from(parseHtml(out).querySelectorAll("td"))) expect(td.textContent).not.toMatch(/May|June/);
		expect(out).toContain("<option>May</option>");
		// ... but only in a month select: the same words in another select are names
	});

	it("a name written with entities is one fake name, not three", () => {
		const out = rewriteEasySpeakPage(page(`<td>Ren&eacute; Dup&oacute;nt</td>`));
		expect(isFakeName(parseHtml(out).querySelector("td")?.textContent ?? "")).toBe(true);
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
		// a zero-padded id keeps its width but NOT its zero prefix (round 3: the prefix is not copied), and is its own id:
		// 27182 and 00027182 are two exact keys, so two different fakes
		expect(out).toMatch(/ClubReport\.aspx\?id=\d{8}/);
		expect(out).not.toMatch(/ClubReport\.aspx\?id=000/);
		const own = [...out.matchAll(/c=(\d+)/g)].map((m) => m[1]);
		expect(own[0]).toMatch(/^\d{5}$/);
		expect(own[1]).toMatch(/^\d{8}$/);
		expect(own[1]).not.toMatch(/^000/);
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
		const tds = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(tds[2]).not.toMatch(/x6|6/);
		expect(tds[3]).toBe("Division B");
		expect(tds[4]).toMatch(/^Area \d{2}$/);
		expect(tds[4]).not.toBe("Area 12");
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

/** Digit runs as numbers (leading zeros do not make a run another run). */
const digitRuns = (s: string): string[] => (s.match(/\d+/g) ?? []).map((r) => r.replace(/^0+(?=\d)/, ""));

/**
 * Decision B (#1275): no digit survives. Every digit run in `input` must be absent from `out`, whatever the
 * markup it sat in; a fake phone (`(555) 010-xxxx`) is the contract's own placeholder and is not counted.
 */
function expectNoDigitSurvives(input: string, out: string, allowed: string[] = [], opts: { page?: boolean; stamps?: boolean } = {}) {
	// the digits of markup the generator keeps on purpose (the nbsp entity, a charset, a W3C URL, the viewport scale), as a literal list
	const MARKUP = [
		/&#160;/g,
		/%[0-9a-f]{2}/gi, // a percent-escape is an encoded character, not a number
		/utf-8/gi,
		/iso-8859-1/gi,
		/<!doctype[^>]*>/gi,
		/https?:\/\/www\.w3\.org\/[^\s"']*/gi,
		/-\/\/w3c\/\/dtd[^"']*/gi,
		/initial-scale=1/gi,
		// the allow-list's own digit-carrying strings: tags, classes, ids, a role's rank, a rating code
		/<\/?h[1-6]\b/gi,
		/\b(?:row|date|image|form|v)[1-3]\b/g,
		/\b(?:PM|EH|PI)[1-5]\b/g,
		/\b[1-8](?:st|nd|rd|th) (?:Pref|Speaker|Evaluator)/g,
		/Timer 2 - Online/g,
		// layout attributes are MAPPED now (no layout list), but a mapped value can still be a small number, so the shape stays excused; a radio keeps 1, 2, 5, 6 on an available[] field; a pager keeps a page number 1-9
		/\b(?:colspan|rowspan|size|rows|cols|maxlength|border|cellpadding|cellspacing|width|height)(?:="|\n)(?:\d{1,2}|100%|75%|50%|25%)(?!\d)/gi,
		/type="radio"[^>]*value="[1256]"/gi,
		/\b[1-9]\/[1-9]\b/g,
	];
	const real = new Set(digitRuns(MARKUP.reduce((t, re) => t.replace(re, ""), input)));
	const ok = new Set(allowed.map((r) => r.replace(/^0+(?=\d)/, "")));
	// round 4: the placeholder date of every date that is not a meeting date (2000-01-01 in any of its shapes) is a constant, not a leak; so is the constant 0 / 00 / 000 of a short number
	const PLACEHOLDER_DATES = /2000-01-01|January 1, 2000|Saturday 1st January 2000|Jan 01 00|January 2000|2000-2001/g;
	let text = MARKUP.reduce((t, re) => t.replace(re, ""), everything(out)).replace(/\(555\) 010-\d{4}/g, "").replace(PLACEHOLDER_DATES, "");
	if (opts.page) {
		// A whole page uses up the one-digit fakes (there are ten), so a one-digit run may equal ANOTHER real one-digit
		// run (never its own: the map has no fixed point, and the unit tests above prove that on small pages).
		// A shifted date or time may share a day, a month or a minute with another real one by chance, and is
		// compared whole instead: none of the real dates and times may be in the output.
		const MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
		const stamps = new RegExp(`\\d{4}-\\d{2}-\\d{2}|\\d{1,2}:\\d{2}|\\d{1,2}(?:st|nd|rd|th)\\s+(?:${MON})\\s+\\d{4}|(?:${MON})\\s+\\d{1,2},?\\s+\\d{2,4}`, "gi");
		const outStamps = new Set((text.match(stamps) ?? []).map((t) => t.toLowerCase()));
		// round 4: a synthetic meeting date or a keyed time may equal ANOTHER real one of the page (a whole calendar sits in the same weeks); the date design has its own tests
		if (opts.stamps !== false) for (const t of input.match(stamps) ?? []) expect(outStamps.has(t.toLowerCase()), `the date or time ${t} is still in the generated page`).toBe(false);
		text = text.replace(stamps, "");
	}
	for (const m of text.matchAll(/\d+/g)) {
		const r = m[0].replace(/^0+(?=\d)/, "");
		if (opts.page && r.length === 1) continue;
		if (r === "0") continue;
		const at = m.index ?? 0;
		expect(real.has(r) && !ok.has(r), `the digit run ${r} is still in the generated page, near: ${text.slice(Math.max(0, at - 40), at + 20)}`).toBe(false);
	}
}

describe("round 2 (#1275, decision B): no digit survives", () => {
	const cases: { name: string; body: string; words?: string[] }[] = [
		{ name: "a phone split over table cells", body: "<table><tr><td>415</td><td>555</td><td>01</td><td>32</td></tr></table>" },
		{ name: "a phone split over short divs", body: "<div>41</div><div>55</div><div>55</div><div>01</div><div>32</div>" },
		{ name: "a phone concatenated in a handler", body: `<a href="#" onclick="go('41'+'55'+'55'+'01'+'32')">x</a>` },
		{ name: "a phone as handler arguments", body: `<a href="#" onclick="go(4,1,5,5,5,5,0,1,9,9)">x</a>` },
		{ name: "an unknown handler name", body: `<div onrowantidewell="0">x</div>`, words: ["rowan", "antidewell"] },
		{ name: "window features", body: `<a href="#" onclick="window.open('x.php','_blank','quillon=yes,width=4155,height=5501')">x</a>`, words: ["quillon"] },
		{ name: "map coordinates as an integer pair", body: `<a href="https://easy-speak.org/neardata.php?p=(7314159,2718281)">x</a>` },
		{ name: "map coordinates, m=", body: `<a href="https://easy-speak.org/neardata.php?m=(37,-122),12">x</a>` },
		{ name: "xNN counters", body: "<td>x41 x55 x55 x01 x99</td>" },
		{ name: "percentages", body: "<td>415% 555% 019%</td>" },
		{ name: "times", body: "<td>41:55 55:01</td>" },
		{ name: "an invalid ISO date", body: "<td>2041-55-01</td>" },
		{ name: "a timezone label", body: "<td>QUIL (GMT+12 hrs)</td>", words: ["quil"] },
		{ name: "a level shape", body: "<td>#27-39</td>" },
		{ name: "a leading level", body: "<td>27 - Name</td>" },
		{ name: "a redacted-N look-alike", body: "<td>redacted-7391</td>" },
		{ name: "a title, an id and a person link", body: `<a href="/profile.php?mode=viewprofile&amp;u=12345">Ab</a><div id="speech_900002" title="555">x</div>` },
		{ name: "a house number beside a place", body: "<p>42 <b>Fixture Way</b></p>", words: ["fixture way"] },
	];
	it.each(cases)("$name", ({ body, words }) => {
		const input = page(body);
		const out = rewriteEasySpeakPage(input);
		expectNoDigitSurvives(body, out);
		expectNone(out, words ?? []);
	});

	it("a handler attribute name is a literal list, not a pattern; an unknown one is renamed like any unknown attribute", () => {
		const out = rewriteEasySpeakPage(page(`<div onrowantidewell="x" onclick="go()" onmouseover="go()" onquillon="go()">x</div>`));
		expectNone(out, ["rowan", "antidewell", "quillon"]);
		const names = Array.from(parseHtml(out).querySelector("div")?.attributes ?? []).map((a) => a.name);
		expect(names).toContain("onclick");
		expect(names).toContain("onmouseover");
		expect(names.filter((n) => /^data-x\d+$/.test(n)).length).toBe(2);
	});

	it("a real id that equals an assigned fake is rewritten, never kept, and the map stays one to one", () => {
		const links = ["111111", "222222", "333333"].map((u) => `<a href="/profile.php?mode=viewprofile&amp;u=${u}">Ab</a>`).join("");
		const body = `${links}<div id="speech_900002" data-k="900001"></div><a href="/view_meeting.php?t=900003">m</a>`;
		const out = rewriteEasySpeakPage(page(body));
		expectNoDigitSurvives(body, out);
		const doc = parseHtml(out);
		expect(doc.querySelector("div")?.getAttribute("id")).not.toMatch(/90000[123]/);
		expect(doc.querySelector("a:last-of-type")?.getAttribute("href")).not.toMatch(/90000[123]/);
	});

	it("the digit map is one to one within a run and never maps a run to itself, whatever its length", () => {
		const reals = Array.from({ length: 60 }, (_, i) => String(1000 + i * 37));
		const body = reals.map((r) => `<td>${r}</td>`).join("") + `<td>007</td><td>7</td><td>0</td><td>00</td>`;
		// (a 1-3 digit run is fresh per occurrence now: it keeps its width and is never itself, the map is for 4+ digits)
		const out = rewriteEasySpeakPage(page(body));
		const cells = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(new Set(cells.slice(0, 60)).size, "one to one").toBe(60);
		cells.forEach((c, i) => expect(c.length, `cell ${i} keeps its length`).toBe(i < 60 ? 4 : [3, 1, 1, 2][i - 60]));
		expectNoDigitSurvives(body, out);
		// the same real run is the same fake wherever it appears
		const two = rewriteEasySpeakPage(page(`<td>31415</td><a href="/orgdata.php?c=31415">x</a><div id="r_31415"></div>`));
		const fakes = [...two.matchAll(/\d{5,6}/g)].map((m) => m[0]);
		expect(new Set(fakes).size).toBe(1);
	});

	it("two different real ids never get one fake, even in a one-digit id context (a derangement)", () => {
		const real = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
		for (const seed of ["a", "b", "c", "d", "42"]) {
			const out = rewriteEasySpeakPage(page(real.map((r) => `<a href="/view_meeting.php?t=${r}">m</a>`).join("")), { state: newRewriteState({ seed }) });
			const ids = Array.from(parseHtml(out).querySelectorAll("a")).map((a) => /t=(\d+)/.exec(a.getAttribute("href") ?? "")?.[1] ?? "");
			expect(new Set(ids).size, `seed ${seed}: one to one`).toBe(real.length);
			ids.forEach((c, i) => expect(c, `seed ${seed}: ${real[i]} is not kept`).not.toBe(real[i]));
		}
	});

	it("a real run equal to a fake an earlier page was given gets its own fake", () => {
		const st = newRewriteState();
		const a = rewriteEasySpeakPage(page(`<td>31415</td>`), { state: st });
		const fakeOfA = parseHtml(a).querySelector("td")?.textContent ?? "";
		const b = rewriteEasySpeakPage(page(`<td>${fakeOfA}</td><td>31415</td>`), { state: st });
		const cells = Array.from(parseHtml(b).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(cells[0]).not.toBe(fakeOfA);
		expect(cells[1]).toBe(fakeOfA);
		expect(cells[0]).not.toBe(cells[1]);
	});

	it("attribute renames cannot swallow each other: data-quillon and data-x1 are two names", () => {
		const out = rewriteEasySpeakPage(page(`<div data-quillon="a" data-x1="b" data-zed="c">x</div>`));
		const names = Array.from(parseHtml(out).querySelector("div")?.attributes ?? []).map((a) => a.name);
		expect(names.length).toBe(3);
		expect(new Set(names).size).toBe(3);
		expectNone(out, ["quillon", "zed"]);
	});

	it("a Venue label (a non-breaking space, then the place) stays; a person called Venue does not", () => {
		const label = rewriteEasySpeakPage(page(`<span class="gen">Venue&#160;<b>Quillon Hall</b></span>`));
		expect(label).toContain("Venue");
		expectNone(label, ["quillon"]);
		const plain = rewriteEasySpeakPage(page(`<td>Venue <b>Rowan Tidewell</b></td><td>Rowan <b>Venue</b></td>`));
		expectNone(plain, ["rowan", "tidewell"]);
		for (const td of Array.from(parseHtml(plain).querySelectorAll("td"))) expect(td.textContent, td.innerHTML).not.toMatch(/Venue/);
	});

	it("the evaluations JSON is hand-written: the generator refuses JSON input with a clear message", () => {
		expect(() => rewriteEasySpeakPage(`{"evaluations":[{"speaker":"Rowan Tidewell"}]}`)).toThrow(/JSON/);
		expect(() => generateFixture(`[{"a":1}]`)).toThrow(/JSON/);
		const dir = mkdtempSync(join(tmpdir(), "es-json-"));
		const input = join(dir, "eval.json");
		const out = join(dir, "eval-out.json");
		writeFileSync(input, `{"evaluations":[]}`);
		const r = spawnSync("bun", [SCRIPT, input, out], { encoding: "utf8" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/JSON/);
		expect(existsSync(out)).toBe(false);
	});
});

describe("pages that must not be corrupted", () => {
	it('a surname "Small" leaves <small> intact', () => {
		const out = rewriteEasySpeakPage(page(`<td><small>Fine print</small> Priya Small</td><small>Small</small>`));
		expect(out).toContain("<small>");
		expect(out).toContain("</small>");
		expect(everything(out).replace(/<\/?small>/g, "")).not.toContain("priya");
	});

	it('a surname "May" is replaced, and a date stays a valid date: moved by whole weeks, so its weekday still fits', () => {
		const st = newRewriteState({ seed: "dates", now: Date.UTC(2026, 9, 12) });
		const out = rewriteEasySpeakPage(
			page(`<td class="maintitle">Tuesday 22nd September 2026 at 7:00 pm America/Los_Angeles</td><td>Noah May</td><td>May 2026</td><td>Sep 28 26, 2:43 pm</td><td>2025-05-05</td><td>(Actual meeting detail entered on 2026-10-01)</td>`),
			{ state: st },
		);
		const tds = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		// the weekday of the date still fits (a synthetic date is a whole number of weeks from where its real one sits), the time is another valid time
		const m0 = /^(\w+day) (\d{1,2})(?:st|nd|rd|th) (\w+) (\d{4}) at (?:[1-9]|1[0-2]):[0-5]\d pm America\/Los_Angeles$/.exec(tds[0]);
		expect(m0, tds[0]).toBeTruthy();
		const MONTHS_ = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
		expect(new Date(Date.UTC(Number(m0?.[4]), MONTHS_.indexOf(m0?.[3] ?? ""), Number(m0?.[2]))).getUTCDay()).toBe(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(m0?.[1] ?? ""));
		// round 4: a meeting title is a MEETING date, so it sits in the synthetic calendar, before today (the real one is before it too)
		expect(Date.UTC(Number(m0?.[4]), MONTHS_.indexOf(m0?.[3] ?? ""), Number(m0?.[2]))).toBeLessThan(Date.UTC(2026, 9, 12));
		expect(tds[0]).not.toContain("7:00");
		expect(tds[1]).not.toMatch(/Noah|May/);
		expect(tds[2]).toMatch(/^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/);
		const m3 = /^(\w{3}) (\d{2}) (\d{2}), (?:[1-9]|1[0-2]):[0-5]\d pm$/.exec(tds[3]);
		expect(m3, tds[3]).toBeTruthy();
		expect(tds[4]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(tds[5]).toMatch(/^\(Actual meeting detail entered on \d{4}-\d{2}-\d{2}\)$/);
		// the same real date is one synthetic date wherever it is written: 2026-10-01 here, October 1, 2026 and 1st October 2026 there
		const again = rewriteEasySpeakPage(page(`<td>2026-10-01</td><td>October 1, 2026</td><td>1st October 2026</td>`), { state: st });
		const [iso, long, ord] = Array.from(parseHtml(again).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(iso).toBe(tds[5].replace(/^.*on |\)$/g, ""));
		expect(new Date(`${long} UTC`).toISOString().slice(0, 10)).toBe(iso);
		expect(new Date(`${ord.replace(/(\d)(?:st|nd|rd|th)/, "$1")} UTC`).toISOString().slice(0, 10)).toBe(iso);
		expectNone(out, ["2025", "2:43", "7:00"]);
	});

	it("a date that is not a date is scrubbed whole", () => {
		const out = rewriteEasySpeakPage(page(`<td>31st February 2026</td><td>2026-13-45</td>`), { state: newRewriteState({ seed: "x" }) });
		expectNoDigitSurvives("31 02 2026 2026 13 45", out);
	});

	it('a surname "Page" leaves ?page= and the pager intact', () => {
		const out = rewriteEasySpeakPage(
			page(`<a href="https://easy-speak.org/portal.php?page=4&amp;s=1">map</a><span class="nav">&nbsp;Page <b>1</b> of <b>3</b></span><td>Eli Page</td>`),
		);
		expect(out).toMatch(/portal\.php\?page=\d&amp;s=\d/);
		expect(out).not.toContain("page=4");
		// the pager's two numbers are literal allow-listed ones (1-9); a page count anywhere else is mapped
		expect(out).toContain("Page <b>1</b> of <b>3</b>");
		expectNoDigitSurvives("<p>Page 41 of 55</p>", rewriteEasySpeakPage(page(`<span class="nav">Page <b>41</b> of <b>55</b></span>`)));
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

	it("keeps a Venue label and the shape of a level, so the page still parses, with mapped digits", () => {
		const out = rewriteEasySpeakPage(page(`<span class="gen">Venue&#160;<b><a href="javascript: void(0);">Quillon Hall</a></b></span><td>#2-1 - Effective Quillon</td><td>2 - Humor of Rowan</td>`));
		expect(out).toContain("Venue");
		expect(out).not.toContain("Quillon Hall");
		const tds = Array.from(parseHtml(out).querySelectorAll("td")).map((t) => t.textContent ?? "");
		expect(tds[0]).toMatch(/^#\d+-\d+ - /);
		expect(tds[1]).toMatch(/^\d+ - /);
		expect(tds[0]).not.toMatch(/#2-1/);
		expect(tds[1]).not.toMatch(/^2 /);
		expect(out).not.toMatch(/Quillon|Rowan/);
	});

	it("keeps tags, tag names and attribute names exactly", () => {
		const html = page(`<table class="forumline"><tbody><tr><td colspan="3" class="row1"><span class="gen">Toastmaster</span></td></tr></tbody></table>`);
		const tags = (h: string) => [...parseHtml(h).querySelectorAll("*")].map((e) => `${e.tagName}:${Array.from(e.attributes).map((a) => a.name).join(",")}`);
		expect(tags(rewriteEasySpeakPage(html))).toEqual(tags(html));
	});

	it("is deterministic for one seed, differs for another, and a second pass keeps none of the first pass's digits either", () => {
		const html = page(`<a href="/profile.php?mode=viewprofile&amp;u=555111">Rowan Tidewell</a><td>Sloane Brightmere</td><td>2026-10-01</td><a href="/orgdata.php?c=27182">c</a>`);
		const run = (seed: string) => rewriteEasySpeakPage(html, { state: newRewriteState({ seed }) });
		expect(run("a")).toBe(run("a"));
		expect(run("a")).not.toBe(run("b"));
		const once = run("a");
		expectNoDigitSurvives(once.replace(/<!DOCTYPE[^>]*>/, ""), rewriteEasySpeakPage(once, { state: newRewriteState({ seed: "c" }) }), ["900001"]);
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
	const REAL_IDS = [...new Set(files.flatMap((f) => [...readFixture(f).matchAll(/[?&;](?:t|s)=(\d{4,})/g)].map((m) => m[1])))];
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
		// a meeting id (t=) and a speech id (s=) become invented ones, and each is a term the rewrite must remove
		const ids: string[] = [];
		// every id that appears as t= or s= in ANY committed page is replaced wherever it appears in this one (a form field too)
		for (const id of REAL_IDS) {
			if (new RegExp(`(?<!\\d)${id}(?!\\d)`).test(out)) ids.push(`7${id}`);
			out = out.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, "g"), `7${id}`);
		}
		// an email, and data that sits only in an attribute, with short numbers among the long ones
		const email = "zorvak.quillon@quorvakmail.example";
		terms.push(email, "Zqattrdata");
		out = out.replace("</title>", ` ${email}</title>`).replace(/<body/i, '<body title="Zqattrdata 415 x 4132 y 41 z 55 77"');
		[...phrases.fixturePlaces, ...phrases.speechTitlesAndThemes]
			.sort((a, b) => b.length - a.length)
			.forEach((p, i) => {
				const invented = `zq${base26(i)} glen`;
				if (out.includes(p)) terms.push(invented);
				out = out.replaceAll(p, invented);
			});
		return { html: out, names, terms, ids: [...new Set(ids)] };
	}
	const original = (names: string[], terms: string[]) => ({ names, terms, clubIds: ["7314159", "2718281"], personIds: [] as string[] });
	/** Digit runs invented above that exist in no committed fixture, so any of them in the output is a leak. */
	const INJECTED_RUNS = ["7314159", "2718281"];

	it.each(files)("%s: invented real values put back in are all gone, and the structure is the page's own", (f) => {
		const d = deFake(readFixture(f));
		const r = generateFixture(d.html, { contactPage: isContact(f), state: newRewriteState({ seed: f, now: Date.UTC(2026, 9, 12) }), original: original(d.names, d.terms) });
		expect(r.violations).toEqual([]);
		expect(fixtureViolations(r.html, { contactPage: isContact(f) }), "the committed-fixture check on the generated page").toEqual([]);
		expectNone(r.html, [...d.names, ...d.terms, ...d.ids]);
		expect(r.html).not.toMatch(/7900\d{3}|7314159|2718281|\(212\) 555-/);
		expectNoDigitSurvives(d.html, r.html, [], { page: true, stamps: false });
		for (const run of INJECTED_RUNS) expect(r.html, `injected run ${run}`).not.toContain(run);
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
	/** The bundle with free text blanked, dates and numbers blanked, and every name and id replaced by the order it first appears in: two bundles are the same structure if these are equal. */
	function canon(bundle: unknown): string {
		const seen = new Map<string, string>();
		const tok = (m: string) => {
			let t = seen.get(m);
			if (!t) {
				t = `<${base26(seen.size)}>`;
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
		const alt = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
		// any invented first name with any invented last name (the generator pairs them)
		const names = new RegExp(`(?:${alt(FAKE_FIRSTS)}) (?:${alt(FAKE_LASTS)})`, "g");
		return JSON.stringify(blank(bundle))
			.replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, "<date>") // a shifted date is a different date by design
			.replace(/\d+\.\d+/g, "#")
			.replace(names, tok)
			.replace(/\d{4,}/g, tok) // an id is its order of appearance
			.replace(/\d+(?:\.\d+)?/g, "#"); // a level, a duration, a count is another number by design
	}

	it("the walk still runs, and finds the same meetings, people, roles, speeches and dates, with every id and person lining up across the rewritten pages", async () => {
		const st = newRewriteState({ seed: "walk", now: Date.UTC(2026, 9, 12, 12, 0, 0) });
		// the walker is signed in as the fixture club (4242); the de-faked club id's fake is that one
		presetNumber(st, "7314159", "4242");
		const generated = new Map<string, string>();
		const dFakes = new Map(files.map((f) => [f, deFake(readFixture(f))] as const));
		// the pages share one synthetic calendar, ranked over all their meeting dates
		primeRewriteState(st, [...dFakes.values()].map((d) => d.html));
		const allIds = [...new Set([...dFakes.values()].flatMap((d) => d.ids))];
		const allTerms = [...new Set([...dFakes.values()].flatMap((d) => [...d.names, ...d.terms]))];
		for (const f of ["club-data.html", ...files.filter((x) => x !== "club-data.html")]) {
			const d = dFakes.get(f) as ReturnType<typeof deFake>;
			const r = generateFixture(d.html, { contactPage: isContact(f), state: st, original: { names: d.names, terms: [...d.terms, ...d.ids], clubIds: ["7314159", "2718281"], personIds: [] } });
			expect(r.violations, f).toEqual([]);
			// keeping a meeting id, a speech id, an email or a name goes red here
			expectNone(r.html, [...d.ids, ...d.names, ...d.terms]);
			generated.set(f, r.html);
		}
		expect(allIds.length).toBeGreaterThan(5);
		expect(allTerms.length).toBeGreaterThan(5);
		const fake = (real: string) => st.numbers.get(`7${real}`);
		const extraMeetings: Record<string, string> = {};
		for (const [id, file] of [["644360", "meeting-upcoming.html"], ["644304", "meeting-completed.html"], ["644363", "meeting-table-topics.html"]]) {
			const f = fake(id);
			expect(f, `no fake for meeting ${id}`).toBeTruthy();
			if (f) extraMeetings[f] = file;
		}
		const introId = fake("1473688");
		expect(introId).toBeTruthy();
		// the synthetic calendar keeps each meeting on its side of "now", so the walker's clock is the generator's
		const shifted = Date.UTC(2026, 9, 12, 12, 0, 0);
		const plain = stripClock(await setup().run()).bundle;
		const again = stripClock(
			await setup({
				clock: clock(shifted),
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

describe("round 3 (#1275): digits", () => {
	const cellsOf = (html: string) => Array.from(parseHtml(html).querySelectorAll("td")).map((t) => t.textContent ?? "");

	it("R3-D1b. t=, s= and a club id are consistent inside their own context only: the same id is one fake, another context has its own table", () => {
		const html = page(
			`<a href="/view_meeting.php?t=5">a</a><a href="/view_meeting.php?t=5">b</a><a href="/request_speech.php?s=5">c</a><input type="hidden" name="t" value="5"><a href="/view_meeting.php?c=5">d</a><td>5</td>`,
		);
		let differs = false;
		for (const seed of Array.from({ length: 30 }, (_, i) => `ctx${i}`)) {
			const doc = parseHtml(rewriteEasySpeakPage(html, { state: newRewriteState({ seed }) }));
			const get = (k: string) => [...doc.querySelectorAll("a")].map((a) => new RegExp(`[?&]${k}=(\\d+)`).exec(a.getAttribute("href") ?? "")?.[1]).filter(Boolean);
			const t = get("t");
			expect(t[0], `seed ${seed}: one t id, one fake`).toBe(t[1]);
			expect(doc.querySelector("input")?.getAttribute("value")).toBe(t[0]);
			expect(t[0]).not.toBe("5");
			if (get("s")[0] !== t[0]) differs = true;
		}
		expect(differs, "t and s are separate contexts").toBe(true);
	});

	it("R3-4. public month option values do not decode a phone written one digit per cell (30 seeds)", () => {
		const months = ["January", "February", "March", "April", "May", "June"].map((m, i) => `<option value="${i}">${m}</option>`).join("");
		const phone = "4155550132";
		const html = page(`<select name="month">${months}</select><table><tr>${[...phone].map((d) => `<td>${d}</td>`).join("")}</tr></table>`);
		for (let i = 0; i < 30; i++) {
			const doc = parseHtml(rewriteEasySpeakPage(html, { state: newRewriteState({ seed: `r4-${i}` }) }));
			const inverse = new Map([...doc.querySelectorAll("option")].map((o, k) => [o.getAttribute("value") ?? "", String(k)] as const));
			const recovered = cellsOf(doc.toString())
				.map((c) => inverse.get(c) ?? "?")
				.join("");
			expect(recovered, `seed ${i}`).not.toBe(phone);
		}
	});

	it("R3-D1c. a short id the walker cross-references keeps ONE fake per id and never merges two ids (the seed Codex used, 0-9)", () => {
		const real = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
		const out = rewriteEasySpeakPage(page(real.map((r) => `<a href="/view_meeting.php?t=${r}">m</a>`).join("")), { state: newRewriteState({ seed: "42" }) });
		const ids = Array.from(parseHtml(out).querySelectorAll("a")).map((a) => /t=(\d+)/.exec(a.getAttribute("href") ?? "")?.[1] ?? "");
		expect(new Set(ids).size, "two ids became one fake").toBe(10);
		ids.forEach((c, i) => expect(c).not.toBe(real[i]));
		const three = ["100", "101", "102", "999"].map((r) => `<a href="/view_meeting.php?t=${r}">m</a>`).join("");
		const o3 = Array.from(parseHtml(rewriteEasySpeakPage(page(three))).querySelectorAll("a")).map((a) => /t=(\d+)/.exec(a.getAttribute("href") ?? "")?.[1] ?? "");
		expect(new Set(o3).size).toBe(4);
		for (const c of o3) expect(c).toMatch(/^\d{3}$/);
	});

	it("R3-F5. a page with thousands of distinct 4-digit runs still gets one to one fakes (a deterministic walk, no give-up after 800 tries)", () => {
		const reals = Array.from({ length: 8950 }, (_, i) => String(1000 + i));
		const out = cellsOf(rewriteEasySpeakPage(page(`<table><tr>${reals.map((r) => `<td>${r}</td>`).join("")}</tr></table>`), { state: newRewriteState({ seed: "full" }) }));
		expect(new Set(out).size).toBe(8950);
		out.forEach((c, i) => expect(c).not.toBe(reals[i]));
	});

	it("R3-F5b. a space that is truly full fails explicitly instead of merging two ids", () => {
		const full = newRewriteState({ seed: "fullest" });
		for (let i = 0; i < 9000; i++) full.taken.add(String(1000 + i));
		expect(() => rewriteEasySpeakPage(page("<td>5678</td>"), { state: full })).toThrow(/no fake left/);
	});

	it("R3-10. a zero prefix is not copied: the fake is allocated over the whole width", () => {
		let wide = 0;
		for (let i = 0; i < 40; i++) {
			const [a] = cellsOf(rewriteEasySpeakPage(page("<table><tr><td>00042</td><td>000</td></tr></table>"), { state: newRewriteState({ seed: `z${i}` }) }));
			expect(a).toMatch(/^\d{5}$/);
			if (!a.startsWith("00")) wide++;
		}
		expect(wide, "00042 keeps its 00 prefix").toBeGreaterThan(30);
	});
});

describe("round 3 (#1275): dates", () => {
	const NOW = Date.UTC(2026, 9, 20);
	const ptext = (html: string) => Array.from(parseHtml(html).querySelectorAll("p")).map((t) => t.textContent ?? "");
	const dayOf = (s: string) => Math.floor(Date.parse(`${s} UTC`) / 86_400_000);

	it("R3-6b. a date-shaped text that is not a date keeps neither its month nor its digits", () => {
		const out = ptext(rewriteEasySpeakPage(page("<p>May 99, 2026</p><p>March 45, 2025</p>")));
		expect(out.join("|")).not.toMatch(/May|March|99|45|2026|2025/);
		// ... in every date shape
		const shapes = ptext(rewriteEasySpeakPage(page("<p>Tuesday 31st February 2026 at 7:00 pm</p><p>Feb 31 26, 7:30 pm</p><p>2026-02-30</p><p>2026-13-45</p>")));
		expect(shapes.join("|")).not.toMatch(/Feb|Tuesday|31|30|45|13|2026|26/);
	});

});

describe("round 3 (#1275): a literal exception holds only in its own context", () => {
	it("R3-3a. layout attributes keep no number anywhere: ten of them spell no phone, and a td's colspan is mapped too (20 seeds)", () => {
		const html = page(`<div width="4" height="1" colspan="5" rowspan="5" size="5" rows="5" cols="0" maxlength="1" border="3" cellpadding="2"></div><table><tr><td colspan="5">x</td></tr></table>`);
		for (let i = 0; i < 20; i++) {
			const doc = parseHtml(rewriteEasySpeakPage(html, { state: newRewriteState({ seed: `l${i}` }) }));
			const div = doc.querySelector("div");
			const read = ["width", "height", "colspan", "rowspan", "size", "rows", "cols", "maxlength", "border", "cellpadding"].map((a) => div?.getAttribute(a) ?? "").join("");
			expect(read, `seed ${i}`).not.toBe("4155550132");
			expect(read.length).toBe(10);
			expect(doc.querySelector("td")?.getAttribute("colspan"), `seed ${i}`).not.toBe("5");
		}
	});

	it("R3-3b. a radio keeps its value only on an attendance field (available[id]); any other field's 1, 2, 3 is mapped", () => {
		const other = page(["1", "2", "3"].map((v) => `<input name="speaker" type="radio" value="${v}">`).join(""));
		for (let i = 0; i < 10; i++) {
			const vals = Array.from(parseHtml(rewriteEasySpeakPage(other, { state: newRewriteState({ seed: `r${i}` }) })).querySelectorAll("input")).map((x) => x.getAttribute("value"));
			expect(vals, `seed ${i}`).not.toContain("1");
			expect(vals[1]).not.toBe("2");
			expect(vals[2]).not.toBe("3");
		}
		const own = page(["1", "6", "2", "5"].map((v) => `<input name="available[123456]" type="radio" value="${v}">`).join(""));
		const kept = Array.from(parseHtml(rewriteEasySpeakPage(own)).querySelectorAll("input")).map((x) => x.getAttribute("value"));
		expect(kept).toEqual(["1", "6", "2", "5"]);
		// a value the walker does not read stays out even on an attendance field
		const odd = Array.from(parseHtml(rewriteEasySpeakPage(page(`<input name="available[123456]" type="radio" value="9"><input name="available[123456]" type="radio" value="3">`))).querySelectorAll("input")).map((x) => x.getAttribute("value"));
		expect(odd).not.toContain("9");
		expect(odd).not.toContain("3");
	});

	it("R3-3c. the pager keeps its digits only inside .nav and only when the page is not past the count (20 seeds)", () => {
		const loose = page(`<p>Page 4 of 1</p><p>Page 5 of 5</p><p>Page 5 of 5</p><p>Page 1 of 3</p>`);
		for (let i = 0; i < 20; i++) {
			const out = rewriteEasySpeakPage(loose, { state: newRewriteState({ seed: `p${i}` }) });
			expect(out, `seed ${i}`).not.toMatch(/Page 5 of 5|Page 1 of 3|Page 4 of 1/);
			expect(Array.from(parseHtml(out).querySelectorAll("p")).map((p) => (p.textContent ?? "").replace(/\D/g, "")).join(""), `seed ${i}`).not.toBe("41555513");
		}
		const nav = (t: string) => rewriteEasySpeakPage(page(`<span class="nav">${t}</span>`));
		expect(nav("Page 2 of 3")).toContain("Page 2 of 3");
		expect(nav("Page 4 of 1")).not.toContain("Page 4 of 1");
		expect(nav("Page 12 of 30")).not.toMatch(/12|30/);
		expect(nav("Page 2 of 30")).not.toMatch(/30/);
	});

	it("R3-6. a month name stays only in a month select's options; a name with a punctuation-joined role word is replaced whole", () => {
		const speaker = rewriteEasySpeakPage(page(`<select name="speaker"><option>May</option><option>June</option></select>`));
		expect(speaker).not.toMatch(/May|June/);
		const month = rewriteEasySpeakPage(page(`<select name="end_month"><option>May</option></select>`));
		expect(month).toContain("<option>May</option>");
		const slash = rewriteEasySpeakPage(page(`<p>Quillon/Time</p>`));
		expect(slash).not.toMatch(/Quillon|Time/);
	});
});

describe("round 3 (#1275): text, code and names", () => {
	const gen = (body: string, original?: { names?: string[]; terms?: string[] }) => generateFixture(page(body), { original });

	it("R3-F1. the private-use token brackets cannot be put back by an escape, an entity or a percent-escape: no payload between them survives", () => {
		const payload = "zorvaksecret";
		const cases = [
			`<a href="javascript:void(0)" onclick="x('\\ue000${payload}\\ue001')">a</a>`,
			`<textarea>&#xE000;${payload}&#xE001;</textarea>`,
			`<a href="/orgdata.php?n=%EE%80%80${payload}%EE%80%81">a</a>`,
			`<td data-x="">&#xE000;${payload}&#xE001;</td>`,
		];
		for (const c of cases) {
			const r = gen(c, { terms: [payload] });
			expect(r.html.toLowerCase(), c).not.toContain(payload);
			expect(r.violations, c).toEqual([]);
		}
	});

	it("R3-F2. non-ASCII digits and comments in handler code do not survive (fullwidth, Arabic-Indic, superscript, a comment)", () => {
		const handlers = [
			`f(４８２９１３)`,
			`alert(٤١٥٥٥٥٠١٣٢)`,
			`alert(⁴¹⁵⁵⁵⁵⁰¹³²)`,
			`/* ４１５５５５０１３２ */ return false`,
			`// 4155550132\nreturn false`,
			`/* "quote */ f(1) /* 4155550132 */`,
		];
		for (const h of handlers) {
			const out = rewriteEasySpeakPage(page(`<a onclick="${h}">a</a>`));
			const code = parseHtml(out).querySelector("a")?.getAttribute("onclick") ?? "";
			expect(code, h).not.toMatch(/[^\x00-\x7f]/);
			expect(code, h).not.toMatch(/4155550132|482913/);
			expect(code, h).not.toMatch(/\/\*|\/\//);
		}
	});

	it("R3-1. supplementary-plane letters and digits do not survive in text, a meta content, a srcdoc or entities", () => {
		const bodies = [`<p>𝟜𝟙𝟝𝟝𝟝𝟝𝟘𝟙𝟛𝟚</p>`, `<p>𠮷</p>`, `<p>&#120796;&#120793;&#120797;</p>`, `<p>x 𝟜𝟙𝟝</p>`, `<iframe srcdoc="<p>𝟜𝟙𝟝𝟝</p>"></iframe>`];
		for (const b of bodies) {
			const out = rewriteEasySpeakPage(page(b, `<meta name="description" content="𝟜𝟙𝟝𝟝">`));
			expect(out, b).not.toMatch(/[\u{10000}-\u{10ffff}]/u);
		}
	});

	it("R3-F3. code points outside letters and numbers (circled letters, tag characters) are content too", () => {
		const out = rewriteEasySpeakPage(page(`<td>Ⓡⓞⓦⓐⓝ</td><td>R\u{E0061}\u{E0062}owan</td><td>\u{E0041}\u{E0042}</td>`));
		expect(out).not.toMatch(/Ⓡ|ⓞ|[\u{E0000}-\u{E007F}]/u);
		expect(out.toLowerCase()).not.toContain("rowan");
	});

	it("R3-7. a fake name never shares a word with the page: Avery Quillon is not Avery Alderfinch, and the net catches the real word if it ever is", () => {
		const r = gen(`<p>Avery Alderfinch</p>`, { names: ["Avery Alderfinch"] });
		expect(r.html).not.toMatch(/Avery|Alderfinch/);
		const q = gen(`<p>Avery Quillon</p>`, { names: ["Avery Quillon"] });
		expect(q.violations).toEqual([]);
		expect(q.html).not.toMatch(/Avery|Quillon/);
		// the net itself: a real word beside a fake name is reported even when the fake name happens to share it
		const shared = fixtureViolations(page(`<p>Avery Alderfinch</p>`), { original: { names: ["Avery Quillon"] } });
		expect(shared.join("\n")).toMatch(/avery/i);
	});

	it("R3-9. a 24-hour and a 12-hour time of the same digits are valid times of their own format", () => {
		const out = Array.from(parseHtml(rewriteEasySpeakPage(page(`<p>11:30</p><p>11:30am</p><p>25:61</p>`), { state: newRewriteState({ seed: "t" }) })).querySelectorAll("p")).map((p) => p.textContent ?? "");
		expect(out[0]).toMatch(/^(?:\d|1\d|2[0-3]):[0-5]\d$/);
		expect(out[1]).toMatch(/^(?:[1-9]|1[0-2]):[0-5]\d ?am$/);
		expect(out[2]).not.toMatch(/25|61/);
		for (let i = 0; i < 25; i++) {
			const [a, b] = Array.from(parseHtml(rewriteEasySpeakPage(page(`<p>11:30</p><p>11:30pm</p>`), { state: newRewriteState({ seed: `t${i}` }) })).querySelectorAll("p")).map((p) => p.textContent ?? "");
			expect(Number(a.split(":")[0]), `seed ${i}`).toBeLessThanOrEqual(23);
			expect(Number(b.split(":")[0]), `seed ${i}`).toBeLessThanOrEqual(12);
			expect(Number(b.split(":")[0])).toBeGreaterThanOrEqual(1);
		}
	});

	it("R3-7b. a real person called Topics is still found, but a phrase word shared with an allowed phrase is not a finding by itself", () => {
		const v = (b: string, names: string[]) => fixtureViolations(page(b), { original: { names } }).join("\n");
		expect(v(`<p>Table Topics Speakers</p>`, ["Rowan Topics"])).not.toMatch(/topics.*(?:real|original)|(?:real|original).*topics/i);
		expect(v(`<p>Rowan Quillbright</p>`, ["Rowan Topics"])).toMatch(/rowan/i);
	});

	it("R3-1b. a supplementary-plane punctuation mark is not content: the scan counts code points, not UTF-16 units", () => {
		const out = parseHtml(rewriteEasySpeakPage(page(`<td>Rowan \u{10100}</td>`))).querySelector("td")?.textContent ?? "";
		expect(out).toMatch(/\u{10100}$/u);
		expect(out).not.toMatch(/Rowan/);
	});

	it("R3-F3b. a fullwidth digit run is read as the digits it stands for and gets an ASCII fake", () => {
		const out = parseHtml(rewriteEasySpeakPage(page(`<td>１２３４５６</td>`))).querySelector("td")?.textContent ?? "";
		expect(out).toMatch(/^\d{6}$/);
		expect(out).not.toBe("123456");
	});

	it("R3-F2b. a fullwidth or superscript digit in handler code is read as the digit it stands for and gets an ASCII fake", () => {
		for (const h of ["f(４８２９１３)", "f(⁴⁸²⁹¹³)"]) {
			const code = parseHtml(rewriteEasySpeakPage(page(`<a onclick="${h}">a</a>`))).querySelector("a")?.getAttribute("onclick") ?? "";
			expect(code, h).toMatch(/^x\(\d{6}\)$/);
			expect(code, h).not.toContain("482913");
		}
	});
});

describe("round 4 (#1275, option A: simpler fakes)", () => {
	const NOW = Date.UTC(2026, 9, 20);
	const TODAY = Math.floor(NOW / 86_400_000);
	const texts = (html: string, sel = "p") => Array.from(parseHtml(html).querySelectorAll(sel)).map((t) => t.textContent ?? "");
	const dayOf = (s: string) => Math.floor(Date.parse(`${s} UTC`) / 86_400_000);
	const gen = (body: string, seed: string, extra: { contactPage?: boolean } = {}) => generateFixture(page(body), { state: newRewriteState({ seed, now: NOW }), ...extra });
	const meet = (iso: string, t = 1) => `<td><a href="https://easy-speak.org/view_meeting.php?t=${t}">${iso}</a></td>`;
	const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
	// FNV-1a-32 as the old generator seeded with: two seeds whose `seed|` collide had byte-identical output
	const fnv = (s: string) => {
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	};

	it("R4-K1. the randomness is HMAC-keyed with 256 random bits per run: two seeds an FNV-32 hash cannot tell apart give different output", () => {
		const seen = new Map<number, string>();
		let pair: [string, string] | null = null;
		for (let i = 0; pair === null && i < 400_000; i++) {
			const h = fnv(`k${i}|`);
			const other = seen.get(h);
			if (other !== undefined) pair = [other, `k${i}`];
			else seen.set(h, `k${i}`);
		}
		expect(pair, "an FNV-32 collision among 400k seeds").not.toBeNull();
		const body = Array.from({ length: 6 }, (_, i) => `<td>${7_100_000 + i * 13}</td><td>Rowan Tidewell${i}</td>`).join("");
		const [a, b] = (pair as [string, string]).map((seed) => rewriteEasySpeakPage(page(body), { state: newRewriteState({ seed }) }));
		expect(a, "same FNV state, so the old output was identical").not.toBe(b);
		const fresh = [newRewriteState(), newRewriteState()];
		expect(fresh[0].key.length).toBe(32);
		expect(fresh[0].key.equals(fresh[1].key)).toBe(false);
	});

	it("R4-D1. member dates are one fixed placeholder: a known real-to-fake pair of two days in a row recovers nothing", () => {
		const out = texts(rewriteEasySpeakPage(page("<p>2026-10-18</p><p>2026-10-19</p><p>1999-12-31</p>"), { state: newRewriteState({ seed: "date-probe-53", now: NOW }) }));
		expect(out).toEqual(["2000-01-01", "2000-01-01", "2000-01-01"]);
		for (const shape of ["October 18, 2026", "Tuesday 20th October 2026 at 7:00 pm", "Oct 18 26, 7:30 pm", "October 2026"]) {
			const o = texts(rewriteEasySpeakPage(page(`<p>${shape}</p>`), { state: newRewriteState({ seed: "s", now: NOW }) }))[0];
			expect(o, shape).not.toMatch(/2026|2025|18|20(?!00)/);
		}
	});

	it("R4-D2. the meeting calendar is built from rank, not from the real gaps: weekly, ordered, and a member date between two meetings stays the placeholder", () => {
		// real gaps of 1, 3 and 40 days, with a member date sitting between the first two
		const real = ["2026-09-01", "2026-09-02", "2026-09-05", "2026-10-15", "2026-10-25", "2026-10-26"];
		for (let i = 0; i < 12; i++) {
			const html = page(`<table><tr>${real.map((d) => meet(d)).join("")}</tr></table><p>2026-09-01 joined</p><p>2026-09-03</p>`);
			const out = rewriteEasySpeakPage(html, { state: newRewriteState({ seed: `cal${i}`, now: NOW }) });
			const days = texts(out, "a").map(dayOf);
			for (let k = 1; k < days.length; k++) expect(days[k] - days[k - 1], `seed ${i}: a week apart whatever the real gap`).toBe(k === 4 ? 7 : 7);
			// the order, and the side of today: four completed meetings (before 2026-10-20), two upcoming
			expect(days.slice(0, 4).every((d) => d < TODAY)).toBe(true);
			expect(days.slice(4).every((d) => d > TODAY)).toBe(true);
			expect(texts(out).map((x) => x.slice(0, 10))).toEqual(["2000-01-01", "2000-01-01"]);
		}
	});

	it("R4-D3. one known pair of meeting dates gives no other date: the offset between two fakes is the rank difference whatever the real distance", () => {
		const weekdays = new Set<number>();
		for (const gap of [3, 10, 40, 400]) {
			const a = TODAY + 2;
			const o = texts(rewriteEasySpeakPage(page(`<table><tr>${meet(iso(a))}${meet(iso(a + gap), 2)}</tr></table>`), { state: newRewriteState({ seed: "pair", now: NOW }) }), "a").map(dayOf);
			expect(o[1] - o[0], `a real gap of ${gap} days`).toBe(7);
			weekdays.add(new Date(o[0] * 86_400_000).getUTCDay());
		}
		const days = new Set<number>();
		for (let i = 0; i < 30; i++) days.add(dayOf(texts(rewriteEasySpeakPage(page(`<table><tr>${meet(iso(TODAY + 2))}</tr></table>`), { state: newRewriteState({ seed: `w${i}`, now: NOW }) }), "a")[0]));
		expect(days.size, "the weekday is keyed").toBeGreaterThan(2);
	});

	it("R4-D4. a meeting date that falls between those of an earlier page of the state is refused, and priming the state with every page first is the way", () => {
		const a = page(`<table><tr>${meet("2026-11-01")}${meet("2026-11-20", 2)}</tr></table>`);
		const b = page(`<table><tr>${meet("2026-11-10", 3)}</tr></table>`);
		const st = newRewriteState({ seed: "x", now: NOW });
		rewriteEasySpeakPage(a, { state: st });
		expect(() => rewriteEasySpeakPage(b, { state: st })).toThrow(/falls between/);
		const primed = newRewriteState({ seed: "x", now: NOW });
		primeRewriteState(primed, [a, b]);
		const days = [a, b].flatMap((h) => texts(rewriteEasySpeakPage(h, { state: primed }), "a").map(dayOf));
		expect(days[2] > days[0] && days[2] < days[1], "ranked over both pages").toBe(true);
	});

	it("R4-S1. a 1-3 digit run outside an id context is one constant per width: nothing is learnt from a repeated value or from the values left out", () => {
		for (const seed of ["a", "b", "c"]) {
			const out = texts(rewriteEasySpeakPage(page("<p>7</p>".repeat(32)), { state: newRewriteState({ seed }) }));
			expect(new Set(out), "32 sevens, one output").toEqual(new Set(["0"]));
		}
		const tens = "<p>10</p>".repeat(60) + "<p>47</p><p>470</p>";
		const out = texts(rewriteEasySpeakPage(page(tens), { state: newRewriteState({ seed: "ten" }) }));
		expect(new Set(out.slice(0, 61)), "the page's own small numbers are not avoided").toEqual(new Set(["00"]));
		expect(out[61]).toBe("000");
	});

	it("R4-M1. a decoded private-use character cannot make a phone trusted: entity, JS escape and percent forms are all rewritten", () => {
		const cases = [
			`<textarea>&#xE000;(555) 010-0132&#xE001;</textarea>`,
			`<a href="#" onclick="alert('\\uE000(555) 010-0132\\uE001')">Go</a>`,
			`<a href="clubdata.php?n=%EE%80%80(555)%20010-0132%EE%80%81">Go</a>`,
			`<p>(555) 010-0132</p>`,
		];
		for (const body of cases) {
			const r = gen(body, "m1", { contactPage: true });
			expect(r.html, body).not.toContain("0132");
			expect(r.html, body).not.toMatch(/[]/);
			expect(r.violations, body).toEqual([]);
		}
	});

	it("R4-N1. a name spelled with a JS escape or a percent escape is still a page word: no fake first name or surname is its", () => {
		for (let i = 0; i < 40; i++) {
			const js = rewriteEasySpeakPage(page(`<a href="#" onclick="alert('\\u0041very Tidewell')">Go</a>`), { state: newRewriteState({ seed: `n${i}` }) });
			const pc = rewriteEasySpeakPage(page(`<a href="clubdata.php?n=%41very%20Tidewell">Go</a>`), { state: newRewriteState({ seed: `n${i}` }) });
			expect(js.toLowerCase(), `seed ${i}`).not.toMatch(/avery|tidewell/);
			expect(pc.toLowerCase(), `seed ${i}`).not.toMatch(/avery|tidewell/);
		}
	});

	it("R4-P1. `Page` is kept only in the pager: a surname Page in its own block is replaced, the pager still reads Page 1 of 2", () => {
		const out = texts(rewriteEasySpeakPage(page("<p>Rowan</p><p>Page</p><p>of</p>"), { state: newRewriteState({ seed: "p" }) }));
		expect(out.join("|")).not.toMatch(/Rowan|Page|\bof\b/);
		const pager = rewriteEasySpeakPage(page(`<div class="nav">Page <b>1</b> of <b>2</b></div>`));
		expect(texts(pager, ".nav")[0]).toBe("Page 1 of 2");
	});

	it("R4-Q1. a fake phone never ends in the input's four digits or equals the input; the fake username is never the input's", () => {
		for (const input of ["415 555 0001", "(555) 010-0001", "555-010-0001", "(212) 555-0133"]) {
			const out = texts(rewriteEasySpeakPage(page(`<p>${input}</p>`), { state: newRewriteState({ seed: "q" }) }))[0];
			expect(out, input).toMatch(/^\(555\) 010-\d{4}$/);
			expect(out, input).not.toBe(input);
			expect(out.slice(-4), input).not.toBe(input.slice(-4));
		}
		for (const [input, seed] of [["[fixtureuser]", "u"], ["[FixtureUser]", "u2"]]) {
			const r = generateFixture(page(`<p>${input}</p>`), { state: newRewriteState({ seed }) });
			expect(texts(r.html)[0].toLowerCase()).not.toBe("[fixtureuser]");
			expect(r.violations).toEqual([]);
		}
	});

	it("R4-Q2. the fake names come from a keyed order: the first allocation is not always the same name, so the skip pattern says nothing", () => {
		const firsts = new Set<string>();
		for (let i = 0; i < 30; i++) firsts.add(texts(rewriteEasySpeakPage(page("<td>Zq Brackenby</td>"), { state: newRewriteState({ seed: `o${i}` }) }), "td")[0]);
		expect(firsts.size, "a keyed order, not a fixed list").toBeGreaterThan(10);
	});

	it("R4-X1. a date is never joined into a phone across blocks, and the page does not crash on it", () => {
		for (const body of ["<p>2025-03-12</p><p>4815162</p>", "<td><b>2025-03-12</b> <i>4815162</i></td>"]) {
			const out = rewriteEasySpeakPage(page(body), { state: newRewriteState({ seed: "x" }) });
			expect(out, body).toContain("2000-01-01");
			expect(out, body).not.toContain("(555)");
			expect(out, body).not.toContain("4815162");
		}
	});

	it("R4-X2. 150 distinct names on one page get 150 distinct fakes: the pool is first x last, not 81", () => {
		const base26 = (n: number) => String.fromCharCode(97 + (n % 26)) + String.fromCharCode(97 + (Math.floor(n / 26) % 26));
		const names = Array.from({ length: 150 }, (_, i) => `Zq${base26(i)}ovak Brack${base26(i)}enby`);
		const out = texts(rewriteEasySpeakPage(page(names.map((n) => `<td>${n}</td>`).join("")), { state: newRewriteState({ seed: "many" }) }), "td");
		expect(new Set(out).size).toBe(150);
		for (const o of out) expect(isFakeName(o), o).toBe(true);
	});

	it("R4-X3. a phone-shaped number in code does not trip the net", () => {
		const r = gen(`<a href="#" onclick="f(415.555.0132)">x</a>`, "f");
		expect(r.violations).toEqual([]);
		expect(r.html).not.toContain("0132");
	});
});
