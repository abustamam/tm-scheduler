/**
 * Guards on the committed Easy-Speak fixtures and on the manifest (#1047).
 *
 * This repo is public. The fixtures were saved from a real club and rewritten;
 * these tests are what stops a real name, id, username, phone number or email
 * from coming back in with the next fixture someone adds.
 * Run: cd extension && bunx vitest run lib/easy-speak-fixtures.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../wxt.config";
import { BASECAMP_MATCHES } from "./basecamp-hosts";
import { type EasySpeakBundleV1, isContactPage } from "./easy-speak-bundle";
import { EASY_SPEAK_MATCHES } from "./easy-speak-hosts";
import { stripCredentials } from "./easy-speak-parse";
import { norm } from "./easy-speak-text";
import {
	EMAIL,
	PHONE,
	fixtureDoc,
	fixturePath,
	nameShapedRuns,
	nameShapedRunsInJson,
	parseHtml,
	readFixture,
} from "./easy-speak-test-kit";

const NOT_FIXTURES = ["fake-names.json", "bundle.expected.json", "non-person-phrases.json"];
const files = readdirSync(fixturePath("."))
	.filter((f) => /\.(html|json)$/.test(f) && !NOT_FIXTURES.includes(f));
const htmlFiles = files.filter((f) => f.endsWith(".html"));
const jsonFiles = files.filter((f) => f.endsWith(".json"));
const fake = JSON.parse(readFixture("fake-names.json")) as { names: string[]; usernames: string[] };
const names = new Set(fake.names);
const allowed = JSON.parse(readFixture("non-person-phrases.json")) as Record<string, string[] | string>;
const phrases = new Set(Object.entries(allowed).filter(([k]) => k !== "_about").flatMap(([, v]) => v as string[]));

/** A name-shaped run that is neither a fake person nor an allowed non-person phrase. */
const unknownRuns = (runs: string[]) => runs.filter((r) => !names.has(r) && !phrases.has(r));
const expected = (): EasySpeakBundleV1 => JSON.parse(readFixture("bundle.expected.json"));

/** Every person name the bundle carries, wherever the contract puts one. */
function bundleNames(b: EasySpeakBundleV1): string[] {
	const out: string[] = [];
	const ref = (r: { name: string } | null | undefined) => r && out.push(r.name);
	out.push(...b.people.map((p) => p.name));
	for (const m of b.meetings) {
		if (m.manager) out.push(m.manager);
		for (const r of m.roles) ref(r.holder);
		for (const a of m.attendance) ref(a.who);
		for (const g of m.guests) ref(g.who);
		for (const a of m.awards) ref(a.who);
		for (const t of m.tableTopics) ref(t.who);
	}
	for (const s of b.speechRequests) ref(s.who);
	for (const m of b.mentors) {
		ref(m.mentee);
		ref(m.mentor);
	}
	for (const v of b.visitorsIntroduced) {
		ref(v.visitor);
		ref(v.introducedBy);
	}
	for (const e of b.evaluations) {
		ref(e.speaker);
		ref(e.evaluator);
	}
	return out;
}

describe("the fake-name list", () => {
	it("is only fake names, each used once, and one username", () => {
		expect(new Set(fake.names).size).toBe(fake.names.length);
		expect(fake.usernames).toEqual(["fixtureuser"]);
	});
});

describe("fixtures contain no real names", () => {
	it("every person named in the bundle is in the fake-name list", () => {
		const bad = bundleNames(expected())
			.map(stripCredentials)
			.filter((n) => !names.has(n));
		expect(bad).toEqual([]);
	});

	it.each(htmlFiles)("%s: every person link and header name is in the fake-name list", (file) => {
		const doc = fixtureDoc(file);
		const found: string[] = [];
		for (const a of Array.from(doc.querySelectorAll("a"))) {
			const attrs = `${a.getAttribute("href") ?? ""} ${a.getAttribute("onclick") ?? ""}`;
			if (!/[?&;]u=\d+/.test(attrs)) continue;
			const t = stripCredentials(norm(a.textContent));
			// Not a person: the viewer's own "Request a Speech..." link and an "Accept" button.
			if (t === "" || /^(Request a Speech\.\.\.|Accept|TBA)$/.test(t)) continue;
			found.push(t);
		}
		const header = /Welcome back\s+(.+?)\s*\[/.exec(norm(doc.body?.textContent));
		if (header) found.push(stripCredentials(header[1]));
		expect(found.filter((n) => !names.has(n))).toEqual([]);
	});

	it.each(files.filter((f) => f.endsWith(".json")))("%s: every name field is in the fake-name list", (file) => {
		const strings: string[] = [];
		const walk = (v: unknown, key = "") => {
			if (Array.isArray(v)) for (const x of v) walk(x, key);
			else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
			else if (typeof v === "string" && /_name$/.test(key)) strings.push(v);
		};
		walk(JSON.parse(readFixture(file)));
		expect(strings.filter((n) => !names.has(n))).toEqual([]);
	});

	it.each(htmlFiles)("%s: only fake person ids, one fake username, no leftover evaluator history", (file) => {
		const html = readFixture(file);
		// Every place a person's id appears: a link's u=, and the attendance rows' name/id attributes.
		const ids = [...html.matchAll(/(?:[?&;]u=|attend_image1?\[|available\[|rec\[|available_|email_chk_\d+" name="rec\[)(\d+)/g)].map((m) => Number(m[1]));
		expect(ids.filter((n) => n < 900_001 || n > 900_999)).toEqual([]);
		expect(html).not.toMatch(/Accepted by|Previous Evaluators|I am NOT attending this meeting \(/);
		const usernames = [...html.matchAll(/\[([A-Za-z0-9_]+)\]&nbsp;/g)].map((m) => m[1]);
		expect(usernames.filter((u) => u !== "fixtureuser")).toEqual([]);
	});
});

/**
 * The checks above only look at links, the welcome header and `*_name` keys. A real
 * name in plain text (an introduction, a theme, a title, an unlinked chart cell)
 * would pass them. This is the net for that: every run of two or more capitalised
 * words anywhere a reader can see, in text or in a title/alt/value attribute, is
 * a fake person or a phrase listed in `non-person-phrases.json`.
 */
describe("fixtures contain no real names in plain text either", () => {
	it.each(htmlFiles)("%s: every name-shaped run is a fake name or an allowed non-person phrase", (file) => {
		expect(unknownRuns(nameShapedRuns(fixtureDoc(file)))).toEqual([]);
	});

	it.each(jsonFiles)("%s: every name-shaped run in any string is a fake name or an allowed phrase", (file) => {
		expect(unknownRuns(nameShapedRunsInJson(JSON.parse(readFixture(file))))).toEqual([]);
	});

	it("catches a made-up name in an introduction, a heading, an attribute and a JSON string", () => {
		const html = readFixture("speech-request-intro.html").replace(
			"</body>",
			'<p>Introducing Pat Quillfeather tonight</p><h3>Welcome Robin Marsh-Test</h3><input type="hidden" value="Quincy Fenwick"></body>',
		);
		expect(unknownRuns(nameShapedRuns(parseHtml(html)))).toEqual([
			"Introducing Pat Quillfeather",
			"Welcome Robin Marsh-Test",
			"Quincy Fenwick",
		]);
		expect(unknownRuns(nameShapedRunsInJson({ evaluation: { responses: [{ text_value: "Great job Morgan Tillerman" }] } }))).toEqual(["Morgan Tillerman"]);
	});

	it("does not flag the fake names or the allowed phrases themselves", () => {
		const doc = parseHtml(`<p>${[...names][0]}</p><p>${[...phrases][0]}</p>`);
		expect(unknownRuns(nameShapedRuns(doc))).toEqual([]);
	});

	it("keeps the allow-list honest: no fake name in it, and every phrase is used by a fixture", () => {
		expect([...phrases].filter((p) => names.has(p))).toEqual([]);
		const used = new Set<string>();
		for (const f of htmlFiles) for (const r of nameShapedRuns(fixtureDoc(f))) used.add(r);
		for (const f of jsonFiles) for (const r of nameShapedRunsInJson(JSON.parse(readFixture(f)))) used.add(r);
		expect([...phrases].filter((p) => !used.has(p))).toEqual([]);
	});
});

describe("fixtures contain no real phone numbers or emails", () => {
	// `.test()` on a global regex remembers where it stopped, so the shared one is not global.
	const PHONE_ALL = new RegExp(PHONE.source, "g");

	it.each(files)("%s: any phone is the (555) 010-xxxx fake range, and there is no email", (file) => {
		const text = readFixture(file);
		for (const m of text.match(PHONE_ALL) ?? []) expect(m).toMatch(/^\(555\) 010-\d{4}$/);
		expect(text).not.toMatch(EMAIL);
	});

	it("the only fixtures with a phone are the two contact pages", () => {
		const withPhone = files.filter((f) => PHONE.test(readFixture(f)));
		expect(withPhone.sort()).toEqual(["club-data.html", "member-list.html"]);
	});

	it("the shared patterns keep no state between .test() calls (a global regex skips matches)", () => {
		for (const re of [PHONE, EMAIL]) {
			const sample = re === PHONE ? "call (555) 010-0101 today" : "write to someone@example.com";
			expect(re.test(sample)).toBe(true);
			expect(re.test(sample)).toBe(true);
		}
	});

	it("the contact pages are the ones the walk keeps out of raw", () => {
		expect(isContactPage("https://easy-speak.org/clubdata.php")).toBe(true);
		expect(isContactPage("https://easy-speak.org/memberlist.php")).toBe(true);
	});
});

/**
 * AC5, reading the config rather than the built manifest. Building (`wxt build`)
 * inside vitest is too heavy for a unit run, and the `extension` CI job builds the
 * extension anyway; `wxt.config.ts` is the manifest's single source, so this reads
 * the function WXT calls to make it, and the content scripts' own `matches`.
 * Both are compared with the EXACT hosts the extension had before Easy-Speak
 * (hard-coded here), so any new host, wildcard or localhost entry fails.
 */
describe("the manifest", () => {
	const GAVELUP = `${new URL(process.env.WXT_GAVELUP_URL ?? "https://gavelup.app").origin}/*`;
	// Exactly what origin/main granted before #1047.
	const BEFORE = [
		"https://basecamp.toastmasters.org/*",
		"https://app.basecamp.toastmasters.org/*",
		"https://apps.basecamp.toastmasters.org/*",
		GAVELUP,
	];
	const manifest = async () =>
		(await (config.manifest as (env: unknown) => Promise<Record<string, unknown>>)({
			browser: "chrome",
			manifestVersion: 3,
			mode: "production",
			command: "build",
		})) as { permissions: string[]; host_permissions: string[] };

	it("adds https://easy-speak.org/* as its only new host and no new permission", async () => {
		const m = await manifest();
		expect(EASY_SPEAK_MATCHES).toEqual(["https://easy-speak.org/*"]);
		expect([...m.host_permissions].sort()).toEqual([...BEFORE, "https://easy-speak.org/*"].sort());
		expect(m.permissions).toEqual(["storage", "activeTab"]);
		expect([...BASECAMP_MATCHES].sort()).toEqual(BEFORE.slice(0, 3).sort());
	});

	/** The `matches` of one content script: spread constants resolved, string literals as written. */
	const MATCH_CONSTANTS: Record<string, readonly string[]> = {
		BASECAMP_MATCHES,
		EASY_SPEAK_MATCHES,
	};
	function contentScriptMatches(file: string): string[] {
		const src = readFileSync(new URL(`../entrypoints/${file}`, import.meta.url), "utf8");
		const body = /\bmatches:\s*\[([^\]]*)\]/.exec(src)?.[1];
		if (body === undefined) throw new Error(`${file} has no matches: [...]`);
		return body
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.flatMap((t) => {
				const spread = /^\.\.\.(\w+)$/.exec(t);
				if (spread) {
					const list = MATCH_CONSTANTS[spread[1]];
					if (!list) throw new Error(`${file}: unknown match list ${spread[1]}`);
					return [...list];
				}
				const lit = /^["'`](.+)["'`]$/.exec(t);
				if (lit) return [lit[1]];
				throw new Error(`${file}: cannot read match ${t}`);
			});
	}

	it("injects content scripts only on the Base Camp hosts and Easy-Speak, and no script is added unseen", () => {
		const scripts = readdirSync(new URL("../entrypoints/", import.meta.url)).filter((f) => f.endsWith(".content.ts")).sort();
		expect(scripts).toEqual(["basecamp.content.ts", "easyspeak.content.ts", "inject.content.ts"]);
		expect(contentScriptMatches("basecamp.content.ts").sort()).toEqual(BEFORE.slice(0, 3).sort());
		expect(contentScriptMatches("inject.content.ts").sort()).toEqual(BEFORE.slice(0, 3).sort());
		expect(contentScriptMatches("easyspeak.content.ts")).toEqual(["https://easy-speak.org/*"]);
	});

	it("keeps the Easy-Speak host list out of the contract module: wxt.config.ts imports the hosts module only", () => {
		const src = readFileSync(new URL("../wxt.config.ts", import.meta.url), "utf8");
		expect(src).toContain('./lib/easy-speak-hosts"');
		expect(src).not.toContain("easy-speak-bundle");
	});

	it("reads a literal pattern as written, so a hand-typed host in a content script would fail", () => {
		// The reader is only a guard if it does not paper over a literal.
		expect(() => contentScriptMatches("does-not-exist.content.ts")).toThrow();
	});
});
