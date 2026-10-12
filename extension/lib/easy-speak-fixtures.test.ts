/**
 * Guards on the committed Easy-Speak fixtures and on the manifest (#1047).
 *
 * This repo is public. The fixtures were saved from a real club and rewritten;
 * these tests are what stops a real name, id, username, phone number or email
 * from coming back in with the next fixture someone adds.
 * Run: cd extension && bunx vitest run lib/easy-speak-fixtures.test.ts
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../wxt.config";
import { EASY_SPEAK_MATCHES, type EasySpeakBundleV1 } from "./easy-speak-bundle";
import { BASECAMP_MATCHES } from "./basecamp-hosts";
import { fixtureDoc, fixturePath, readFixture } from "./easy-speak-test-kit";
import { stripCredentials } from "./easy-speak-parse";

const files = readdirSync(fixturePath("."))
	.filter((f) => /\.(html|json)$/.test(f) && f !== "fake-names.json" && f !== "bundle.expected.json");
const htmlFiles = files.filter((f) => f.endsWith(".html"));
const fake = JSON.parse(readFixture("fake-names.json")) as { names: string[]; usernames: string[] };
const names = new Set(fake.names);
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
			const t = stripCredentials((a.textContent ?? "").replace(/[\s ]+/g, " "));
			// Not a person: the viewer's own "Request a Speech..." link and an "Accept" button.
			if (t === "" || /^(Request a Speech\.\.\.|Accept|TBA)$/.test(t)) continue;
			found.push(t);
		}
		const header = /Welcome back\s+(.+?)\s*\[/.exec((doc.body?.textContent ?? "").replace(/[\s ]+/g, " "));
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

describe("fixtures contain no real phone numbers or emails", () => {
	const PHONE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{1,3}[\s.-]\d[\d\s.-]{6,}\d/g;
	const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

	it.each(files)("%s: any phone is the (555) 010-xxxx fake range, and there is no email", (file) => {
		const text = readFixture(file);
		for (const m of text.match(PHONE) ?? []) expect(m).toMatch(/^\(555\) 010-\d{4}$/);
		expect(text).not.toMatch(EMAIL);
	});

	it("the only fixtures with a phone are the two contact pages", () => {
		const withPhone = files.filter((f) => PHONE.test(readFixture(f)));
		PHONE.lastIndex = 0;
		expect(withPhone.sort()).toEqual(["club-data.html", "member-list.html"]);
	});
});

describe("the manifest", () => {
	it("adds https://easy-speak.org/* as its only new host and no new permission", async () => {
		const manifest = (await (config.manifest as (env: unknown) => Promise<Record<string, unknown>>)({
			browser: "chrome",
			manifestVersion: 3,
			mode: "production",
			command: "build",
		})) as { permissions: string[]; host_permissions: string[] };
		expect(EASY_SPEAK_MATCHES).toEqual(["https://easy-speak.org/*"]);
		const hosts = manifest.host_permissions;
		expect(hosts).toContain("https://easy-speak.org/*");
		// Before this change: the Base Camp hosts and the GavelUp origin. Now also Easy-Speak, nothing else.
		expect(hosts.filter((h) => !(BASECAMP_MATCHES as readonly string[]).includes(h) && !/gavelup\.app|localhost/.test(h))).toEqual([
			"https://easy-speak.org/*",
		]);
		expect(manifest.permissions).toEqual(["storage", "activeTab"]);
	});
});
