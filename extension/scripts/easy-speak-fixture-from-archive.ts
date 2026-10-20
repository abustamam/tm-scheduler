/**
 * Turn one page of an Easy-Speak export's `-pages.json` archive (#1241) into an anonymised
 * fixture for `lib/__fixtures__/easy-speak/` (#1252). THIS REPO IS PUBLIC: the archive page is a
 * real club's page and never gets committed; only this script's output does.
 *
 *   bun scripts/easy-speak-fixture-from-archive.ts <archive.json> --list
 *   bun scripts/easy-speak-fixture-from-archive.ts <archive.json> --page <index|url-part> \
 *       --out <name.html> [--name "Real Name"]... [--term "Real Club Name"]... [--dry-run]
 *
 * It strips scripts, styles and comments; swaps every linked person, the viewer and the club for
 * entries of `fake-names.json` and the ranges the fixture guard enforces (ids 900001-900999, phones
 * (555) 010-xxxx, username `fixtureuser`, club id 4242); drops emails. A name it cannot find from a
 * person link or header (plain text: an introduction, a theme) is named with `--name`; a club
 * name, venue or address with `--term`. Then it runs the fixture guard on the result and REFUSES
 * to write a file the guard complains about, printing what to pass to fix it. No allow-list entry
 * is ever added to make it pass.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EsArchiveV1, EsRawPage } from "../lib/easy-speak-bundle";
import { FAKE_NAMES, FAKE_USERNAME, FIXTURE_IDENTITY, fixtureViolations } from "../lib/easy-speak-test-kit";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../lib/__fixtures__/easy-speak");
/** The fake place every `--term` becomes. It is in `non-person-phrases.json`. */
export const FAKE_PLACE = "Fixture Speakers";
const ID_BASE = 900_001;
const ID_MAX = 900_999;

export interface AnonymiseOptions {
	/** Real person names the page carries as plain text, or that no link names. */
	names?: string[];
	/** Real club name, venue, address, district or web address text, replaced with `FAKE_PLACE`. */
	terms?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HTML_ENT: Record<string, string> = { "&amp;": "&", "&nbsp;": " ", "&#160;": " ", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">" };
const decode = (s: string) => s.replace(/&(?:amp|nbsp|quot|apos|lt|gt|#160|#39);/g, (m) => HTML_ENT[m] ?? m);
const clean = (s: string) => decode(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
/** "Dana Vexford, DTM" and "Dana Vexford" are one person. */
const bare = (n: string) => n.replace(/,\s*[A-Z]{2,4}(?:\s+[A-Z]{2,4})*$/, "").trim();

/**
 * The anonymised page, and the problems that stop it being committable. Pure: no file is read or
 * written. Mapping is by first appearance, so the same input always gives the same output.
 */
export function anonymise(raw: string, opts: AnonymiseOptions = {}): { html: string; problems: string[] } {
	let html = raw
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
		.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i, "<title>Fixture :: Easy-Speak</title>");

	// 1. Person ids, in order of first appearance, onto 900001...
	const ids = new Map<string, number>();
	const fakeId = (id: string) => {
		let n = ids.get(id);
		if (n === undefined) {
			n = ID_BASE + ids.size;
			ids.set(id, n);
		}
		return n;
	};
	const problems: string[] = [];
	// Every place the guard looks for an id (the same pattern as `fixtureViolations`).
	html = html.replace(/((?:[?&;]u=|attend_image1?\[|available\[|rec\[|available_|email_chk_\d+" name="rec\[))(\d+)/g, (_m, pre: string, id: string) => `${pre}${fakeId(id)}`);
	if (ids.size > ID_MAX - ID_BASE + 1) problems.push("more people than the 900001-900999 range holds");

	// 2. Names. Person links and the header name give the first ones; `--name` the rest.
	const real: string[] = [];
	const addName = (n: string) => {
		const b = bare(clean(n));
		if (b && !real.includes(b)) real.push(b);
	};
	for (const m of html.matchAll(/<a\b[^>]*[?&;]u=\d+[^>]*>([\s\S]*?)<\/a>/gi)) {
		const t = bare(clean(m[1]));
		if (t && !/^(Request a Speech\.\.\.|Accept|TBA)$/.test(t)) addName(t);
	}
	const header = /Welcome back\s+([^[<]+?)\s*(?:\[|<)/.exec(html);
	if (header) addName(header[1]);
	for (const n of opts.names ?? []) addName(n);
	const mapping = new Map<string, string>();
	for (const n of real) {
		const fake = FAKE_NAMES[mapping.size];
		if (!fake) {
			problems.push(`more distinct people (${real.length}) than fake names (${FAKE_NAMES.length})`);
			break;
		}
		mapping.set(n, fake);
	}
	// Longest first, so "Dana Vexford-Lee" is not half-replaced by "Dana Vexford". A credential
	// suffix ("Dana Vexford, DTM") goes with the name: the replacement drops it.
	for (const [n, fake] of [...mapping].sort((a, b) => b[0].length - a[0].length)) {
		html = html.replace(new RegExp(`${escapeRe(n)}(?:,\\s*[A-Z]{2,4}(?:\\s+[A-Z]{2,4})*)?`, "g"), fake);
	}

	// 3. Usernames: the `[user]&nbsp;` the header and member rows carry.
	for (const m of [...html.matchAll(/\[([A-Za-z0-9_]+)\]&nbsp;/g)]) {
		if (m[1] !== FAKE_USERNAME) html = html.replaceAll(`[${m[1]}]`, `[${FAKE_USERNAME}]`);
	}

	// 4. The club: its id wherever a link or hidden input carries it, then its words.
	html = html
		.replace(/([?&;]c=)\d+/g, `$1${FIXTURE_IDENTITY.esClubId}`)
		.replace(/(name="cached_club"\s+value=")\d+/g, `$1${FIXTURE_IDENTITY.esClubId}`);
	for (const t of [...(opts.terms ?? [])].sort((a, b) => b.length - a.length)) {
		if (t) html = html.replace(new RegExp(escapeRe(t), "gi"), FAKE_PLACE);
	}

	// 5. Phones onto (555) 010-nnnn, in order of first appearance; emails out.
	const phones = new Map<string, string>();
	html = html
		.replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{1,3}[\s.-]\d[\d\s.-]{6,}\d/g, (p) => {
			let f = phones.get(p);
			if (!f) {
				f = `(555) 010-${String(phones.size + 1).padStart(4, "0")}`;
				phones.set(p, f);
			}
			return f;
		})
		.replace(/mailto:[^"'\s>]+/gi, "#")
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "");

	html = `${html.trim()}\n`;
	return { html, problems: [...problems, ...fixtureViolations(html)] };
}

/** The page an archive holds: by 0-based index, or the single page whose URL contains the text. */
export function pickPage(archive: EsArchiveV1, which: string): EsRawPage {
	if (/^\d+$/.test(which)) {
		const p = archive.pages[Number(which)];
		if (!p) throw new Error(`The archive has ${archive.pages.length} pages; there is no page ${which}.`);
		return p;
	}
	const hits = archive.pages.filter((p) => p.url.includes(which));
	if (hits.length !== 1) {
		throw new Error(`${hits.length} pages match "${which}"${hits.length ? `: ${hits.map((h) => h.url).join(", ")}` : ""}. Use the page's index.`);
	}
	return hits[0];
}

function arg(argv: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
	return out;
}

export function main(argv: string[]): number {
	const file = argv[0];
	const [which] = arg(argv, "--page");
	const [out] = arg(argv, "--out");
	if (!file || file.startsWith("--") || (!which && !argv.includes("--list"))) {
		console.error('Usage: easy-speak-fixture-from-archive.ts <archive.json> (--list | --page <index|url-part> --out <name.html> [--name "Real Name"]... [--term "Real Club"]... [--dry-run])');
		return 2;
	}
	const archive = JSON.parse(readFileSync(file, "utf8")) as EsArchiveV1;
	if (archive.format !== "gavelup.easy-speak-pages") {
		console.error(`${file} is not an Easy-Speak pages archive.`);
		return 2;
	}
	if (argv.includes("--list")) {
		archive.pages.forEach((p, i) => console.log(`${i}\t${p.url}`));
		return 0;
	}
	if (!out || !/^[a-z0-9][a-z0-9-]*\.html$/.test(out)) {
		console.error("--out must be a plain file name such as speech-request-regression.html.");
		return 2;
	}
	const page = pickPage(archive, which);
	const { html, problems } = anonymise(page.html, { names: arg(argv, "--name"), terms: arg(argv, "--term") });
	if (problems.length) {
		console.error(`Refusing to write ${out}. The anonymised page still has:`);
		for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
		console.error('Name a person with --name "Real Name", a club name or place with --term "Real Text", then run it again.');
		return 1;
	}
	if (argv.includes("--dry-run")) {
		console.log(`${out}: passes the fixture guard (${html.length} characters). Not written (--dry-run).`);
		return 0;
	}
	const dest = resolve(FIXTURE_DIR, out);
	if (existsSync(dest)) {
		console.error(`${out} already exists; pick another name.`);
		return 1;
	}
	writeFileSync(dest, html);
	console.log(`Wrote ${dest}. Add it to the README table, and a test that replays it.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
