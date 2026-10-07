// Route wiring for the Area Director notice (#1118).
//
// `area-notice.test.tsx` proves the component says the right words, and
// `club-area-notice.integration.test.ts` proves the loader finds the right
// director. Neither proves the settings page shows it: `club-settings.tsx` can
// stop calling the loader, drop the result from its return, read the wrong
// loader key or stop rendering `<AreaNotice`, and type-check, lint and pass
// every other suite (a missing notice is just a page without one). #1115's
// promise is that a club's admins are told BEFORE an Area Director sees its
// numbers, and that promise is only kept while this page shows it, so this is
// the gate on it.
//
// The route cannot mount in jsdom with its real loader, so this reads source.
// COMMENT-BLIND (`readSource`): every assertion is "must BE present", and the
// route's own comments name `<AreaNotice` and `loadClubAreaNotice`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"_authed/admin/club-settings.tsx",
);

/** Split on commas that are not inside (), [] or {}. */
function topLevelItems(text: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			items.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	const last = text.slice(start).trim();
	if (last) items.push(last);
	return items;
}

/** The text between the bracket opening at `open` and its match. */
function balanced(text: string, open: number): string {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "[" || text[i] === "(" || text[i] === "{") depth++;
		if (text[i] === "]" || text[i] === ")" || text[i] === "}") depth--;
		if (depth === 0) return text.slice(open + 1, i);
	}
	throw new Error("unbalanced");
}

describe("club settings shows the Area Director notice (#1118)", () => {
	const src = readSource(ROUTE);
	const loaderAt = src.indexOf("loader: async");
	const loaderEnd = src.indexOf("component: ClubSettings,");
	const componentAt = src.indexOf("function ClubSettings()");
	// The loader alone: the route has helper functions between it and the
	// component, and `return {` appears in some of them.
	const loader = src.slice(loaderAt, loaderEnd);

	it("finds the loader and the component", () => {
		expect(loaderAt).toBeGreaterThan(-1);
		expect(loaderEnd).toBeGreaterThan(loaderAt);
		expect(componentAt).toBeGreaterThan(loaderEnd);
	});

	it("the loader reads the notice for the club the page is showing", () => {
		expect(loader).toContain('import("#/server/club-area-notice")');
		expect(loader).toMatch(
			/loadClubAreaNotice\(\{\s*data:\s*context\.adminClub\.clubId\s*\}\)/,
		);
	});

	it("the notice is bound to `areaNotice` by position, not just by name", () => {
		// `const [profile, …, areaNotice] = await Promise.all([…, <the call>])`
		// binds by POSITION. Reorder one side and the notice becomes the charter,
		// the type-checker may not object, and the page renders nothing or the
		// wrong thing. So the two lists are compared index for index.
		const destructure = loader.match(
			/const \[([^\]]+)\]\s*=\s*await Promise\.all\(\[/,
		);
		expect(destructure, "the loader's Promise.all destructure").not.toBeNull();
		const names = topLevelItems(destructure?.[1] ?? "");
		const allAt = loader.indexOf("Promise.all([") + "Promise.all(".length;
		const entries = topLevelItems(balanced(loader, allAt));
		expect(entries.length).toBe(names.length);
		const at = names.indexOf("areaNotice");
		expect(at, "areaNotice is not destructured").toBeGreaterThan(-1);
		expect(entries[at]).toContain("loadClubAreaNotice(");
	});

	it("the loader hands `areaNotice` to the page", () => {
		const returned = loader.slice(loader.lastIndexOf("return {"));
		expect(returned).toMatch(/\bareaNotice\b,?\s*\}/);
	});

	it("the page reads `areaNotice` from the loader and renders <AreaNotice with it", () => {
		const component = src.slice(componentAt);
		const read = component.match(
			/const \{([^}]*)\} = Route\.useLoaderData\(\)/,
		);
		expect(read, "the component's useLoaderData destructure").not.toBeNull();
		expect(read?.[1]).toMatch(/\bareaNotice\b/);
		expect(component).toMatch(/<AreaNotice\s+notice=\{areaNotice\}\s*\/>/);
	});

	it("renders the notice above the first form, at the top of the page", () => {
		const component = src.slice(componentAt);
		const noticeAt = component.indexOf("<AreaNotice");
		const formAt = component.indexOf("<form");
		expect(noticeAt).toBeGreaterThan(-1);
		expect(formAt).toBeGreaterThan(-1);
		expect(noticeAt).toBeLessThan(formAt);
	});

	it("imports the component it renders", () => {
		expect(src).toMatch(
			/import \{ AreaNotice \} from "#\/components\/club\/area-notice";/,
		);
	});
});
