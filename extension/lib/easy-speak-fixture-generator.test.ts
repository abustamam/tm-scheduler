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
		expect(out).toContain('href="/x.php?x=x&amp;x=x&amp;k=1"');
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

	it("a person's fake is the same in a link and a table, and a fake already on the page is not reused", () => {
		const out = rewriteEasySpeakPage(
			page(
				`<a href="https://easy-speak.org/profile.php?mode=viewprofile&amp;u=555111">Rowan Tidewell, DTM</a><td>Rowan Tidewell</td>` +
					`<a href="https://easy-speak.org/profile.php?mode=viewprofile&amp;u=555222">Sloane Brightmere</a><td>Avery Alderfinch</td>`,
			),
		);
		const links = Array.from(parseHtml(out).querySelectorAll("a")).map((a) => a.textContent ?? "");
		expect(links[0].replace(/, DTM$/, "")).toBe(parseHtml(out).querySelectorAll("td")[0].textContent);
		expect(new Set(links).size).toBe(2);
		expect(out).toContain("Avery Alderfinch");
		expect(links[0]).not.toContain("Avery Alderfinch");
		expect(links[1]).not.toContain("Avery Alderfinch");
		expect(out).toContain(", DTM");
		expect(fixtureViolations(out)).toEqual([]);
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
	it("holds no person's name and no word that is a plausible surname and a date", () => {
		for (const p of ALLOW_LIST.phrases) {
			expect(FAKE_NAMES, p).not.toContain(p);
			expect(p, "an empty phrase matches everything").not.toBe("");
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

	it.each(files)("%s comes out with nothing for fixtureViolations to report", (f) => {
		const r = generateFixture(readFixture(f), { contactPage: isContact(f) });
		expect(r.violations).toEqual([]);
		// the structure is the committed page's own
		const tags = (h: string) => [...parseHtml(h).querySelectorAll("*")].map((e) => e.tagName);
		expect(tags(r.html)).toEqual(tags(readFixture(f)));
	});

	/** The strings a rewrite replaces with a fake on purpose: a theme, a title, an introduction are the club's own words. */
	const FREE_TEXT = new Set(["theme", "wordOfTheDay", "title", "introduction", "topic", "joinUrl", "project", "path", "venue", "name", "manager", "esClubId", "number"]);
	const blank = (v: unknown, key = ""): unknown => {
		if (Array.isArray(v)) return v.map((x) => blank(x, key));
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x, k)]));
		return typeof v === "string" && FREE_TEXT.has(key) ? "*" : v;
	};

	it("the walk still runs, and finds the same meetings, people, roles, speeches and dates in the rewritten pages", async () => {
		const rewritten = (name: string) => (name.endsWith(".html") ? generateFixture(readFixture(name), { contactPage: isContact(name) }).html : readFixture(name));
		const plain = stripClock(await setup().run()).bundle;
		const again = stripClock(await setup({ read: rewritten }).run()).bundle;
		expect(again.meetings.length).toBe(plain.meetings.length);
		expect(blank(again)).toEqual(blank(plain));
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
