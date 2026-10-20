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
 *
 * The guard is a net, not a gate: it catches the shapes of real data it knows. A human reads the
 * generated file before committing it (README).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EsArchiveV1, type EsRawPage, isContactPage } from "../lib/easy-speak-bundle";
import { stripCredentials } from "../lib/easy-speak-parse";
import {
	decodeMarkup,
	FAKE_NAMES,
	FAKE_USERNAME,
	FIXTURE_IDENTITY,
	type FixtureOriginal,
	fixtureViolations,
	isFakePhoneDigits,
	LOOSE_PHONE,
	PERSON_ID_PARAM,
	SHARED_WORDS,
	clubIdRegex,
	phoneDigits,
} from "../lib/easy-speak-test-kit";

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
	/** The club's own ids (the archive's `club.esClubId` and `club.number`), wherever they appear. */
	clubIds?: string[];
	/** The page is one of the two contact pages, the only ones that may carry a phone. */
	contactPage?: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The text of a literal, matching a space as any space, `&nbsp;`, `+` or `%20`. */
const flex = (s: string) => escapeRe(s).replace(/(?:\\ |\s)+/g, "(?:\\s|&nbsp;|&#160;|&#xa0;|\\+|%20)+");
const clean = (s: string) => decodeMarkup(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
/** "Dana Vexford, DTM" and "Dana Vexford" are one person. */
const bare = (n: string) => stripCredentials(n).trim();
const CREDENTIAL = "(?:,\\s*[A-Z]{2,4}(?:\\s+[A-Z]{2,4})*)?";
const idKey = (m: RegExpMatchArray) => Number(m[2]);

/**
 * The anonymised page, and the problems that stop it being committable. Pure: no file is read or
 * written. Mapping is by first appearance, so the same input always gives the same output.
 */
export function anonymise(raw: string, opts: AnonymiseOptions = {}): { html: string; problems: string[] } {
	let html = raw
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
		.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i, "<title>Fixture :: Easy-Speak</title>")
		// `@`, in the few spellings a page uses, so the email pass below sees it.
		.replace(/&#0*64;|&#x0*40;|&commat;|%40/gi, "@");
	const problems: string[] = [];

	// 1. Phones, before any other number is touched: (555) 010-nnnn by first appearance, whatever
	//    the formatting; a number already in the fake range stays; tel: and mailto: links go.
	const phones = new Map<string, string>();
	html = html
		.replace(/\b(?:tel|callto|sms):[^"'\s>]*/gi, "#")
		.replace(/mailto:[^"'\s>]*/gi, "#")
		.replace(new RegExp(LOOSE_PHONE.source, "g"), (p) => {
			const d = phoneDigits(p);
			if (isFakePhoneDigits(d)) return p;
			let f = phones.get(d);
			if (!f) {
				f = `(555) 010-${String(phones.size + 1).padStart(4, "0")}`;
				phones.set(d, f);
			}
			return f;
		})
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "");

	// 2. Person ids, under ANY parameter name, in order of first appearance, onto 900001...
	const ids = new Map<string, number>();
	const fakeId = (id: string) => {
		let n = ids.get(id);
		if (n === undefined) {
			n = ID_BASE + ids.size;
			ids.set(id, n);
		}
		return n;
	};
	html = html.replace(PERSON_ID_PARAM, (_m, pre: string, id: string) => `${pre}${fakeId(id)}`);
	if (ids.size > ID_MAX - ID_BASE + 1) problems.push("more people than the 900001-900999 range holds");

	// 3. The club's ids, wherever they sit: any parameter, any quote, value-first, percent-encoded.
	for (const id of opts.clubIds ?? []) {
		if (id) html = html.replace(clubIdRegex(id), FIXTURE_IDENTITY.esClubId);
	}
	// Whatever the page's own club links still say.
	html = html.replace(/([?&;]c=)\d+/g, `$1${FIXTURE_IDENTITY.esClubId}`).replace(/(name="cached_club"\s+value=")\d+/g, `$1${FIXTURE_IDENTITY.esClubId}`);

	// 4. Names. Person links (by fake id: one person is one id however the link reads), the header
	//    name, then `--name`.
	const byId = new Map<number, string[]>();
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const id = [...decodeMarkup(m[1]).matchAll(PERSON_ID_PARAM)].map(idKey)[0];
		const t = bare(clean(m[2]));
		if (id === undefined || !t || /^(Request a Speech\.\.\.|Accept|TBA)$/.test(t)) continue;
		byId.set(id, [...(byId.get(id) ?? []), t]);
	}
	const people: string[][] = [...byId.values()].map((forms) => [...new Set(forms)].sort((a, b) => b.length - a.length));
	const header = /Welcome back\s+([^[<]+?)\s*(?:\[|<)/.exec(html);
	for (const n of [...(header ? [header[1]] : []), ...(opts.names ?? [])]) {
		const b = bare(clean(n));
		if (b && !people.some((forms) => forms.includes(b))) people.push([b]);
	}
	// A name given in full elsewhere owns its bare forms: an initial is another form of the same person.
	const mapping: { forms: string[]; fake: string }[] = [];
	for (const forms of people) {
		const full = forms[0];
		const existing = mapping.find((p) => p.forms.includes(full));
		if (existing) continue;
		const fake = FAKE_NAMES[mapping.length];
		if (!fake) {
			problems.push(`more distinct people (${people.length}) than fake names (${FAKE_NAMES.length})`);
			break;
		}
		mapping.push({ forms, fake });
	}
	const realNames: string[] = [];
	for (const { forms, fake } of [...mapping].sort((a, b) => b.forms[0].length - a.forms[0].length)) {
		const [first, ...rest] = fake.split(" ");
		const last = rest.join(" ") || first;
		for (const n of forms) {
			// Exact case first, so a credential goes with the name ("Dana Vexford, DTM"); a
			// case-insensitive pass would read ", grows" as one. Then any other case.
			html = html.replace(new RegExp(`${flex(n)}${CREDENTIAL}`, "g"), fake).replace(new RegExp(flex(n), "gi"), fake);
			realNames.push(n);
		}
		// The same person as an initial ("R. Moonstone", "Riley M."), reversed, or one bare word.
		const words = forms[0].split(/\s+/).filter((w) => w.replace(/\W/g, "").length > 0);
		if (words.length >= 2) {
			const f = words[0];
			const l = words[words.length - 1];
			const forms2 = [
				`${escapeRe(f[0])}\\.?\\s+${escapeRe(l)}`,
				`${escapeRe(f)}\\s+${escapeRe(l[0])}\\.?(?![A-Za-z])`,
				`${escapeRe(l)},\\s*${escapeRe(f)}`,
			];
			for (const r of forms2) html = html.replace(new RegExp(`(?<![A-Za-z])${r}`, "gi"), fake);
			for (const [i, w] of words.entries()) {
				const lw = w.replace(/[^A-Za-z'’-]/g, "");
				if (lw.length < 3 || SHARED_WORDS.has(lw.toLowerCase())) continue;
				realNames.push(lw);
				html = html.replace(new RegExp(`(?<![A-Za-z])${escapeRe(lw)}(?![A-Za-z])`, "gi"), i === words.length - 1 ? last : first);
			}
		} else if (words.length === 1 && words[0].length >= 3 && !SHARED_WORDS.has(words[0].toLowerCase())) {
			html = html.replace(new RegExp(`(?<![A-Za-z])${escapeRe(words[0])}(?![A-Za-z])`, "gi"), first);
		}
	}

	// 5. Usernames: the `[user]` the header and member rows carry, with any space after it.
	html = html.replace(/\[([A-Za-z0-9_-]+)\](?=&nbsp;|&#160;|&#xa0;|\s)/gi, (m, u: string) => (/^\d+$/.test(u) ? m : `[${FAKE_USERNAME}]`));

	// 6. The club's words.
	for (const t of [...(opts.terms ?? [])].sort((a, b) => b.length - a.length)) {
		if (t) html = html.replace(new RegExp(flex(t), "gi"), FAKE_PLACE);
	}

	html = `${html.trim()}\n`;
	const original: FixtureOriginal = {
		clubIds: opts.clubIds,
		names: realNames,
		terms: opts.terms,
		personIds: [...ids.keys()],
	};
	return { html, problems: [...problems, ...fixtureViolations(html, { contactPage: opts.contactPage, original })] };
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

export function main(argv: string[], outDir: string = FIXTURE_DIR): number {
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
	const { html, problems } = anonymise(page.html, {
		names: arg(argv, "--name"),
		terms: arg(argv, "--term"),
		clubIds: [archive.club.esClubId, archive.club.number].filter((c): c is string => !!c),
		contactPage: isContactPage(page.url),
	});
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
	const dest = resolve(outDir, out);
	if (existsSync(dest)) {
		console.error(`${out} already exists; pick another name.`);
		return 1;
	}
	writeFileSync(dest, html);
	console.log(`Wrote ${dest}. Add it to the README table, and a test that replays it.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
