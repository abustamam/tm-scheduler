// "Goes by" form round-trip guard (#486). The member and guest edit forms each
// wire the same field across three places that must agree:
//
//   1. the <Input>'s `name` — the key the browser puts in the FormData,
//   2. the `form.get("…")` the submit handler reads back into the payload,
//   3. the `defaultValue` that seeds the field from the stored row.
//
// Nothing type-checks (1) against (2): `form.get` takes a string and returns
// null for a key that isn't there. And the failure is SILENT and destructive
// rather than visible — a mismatch makes `form.get` return null, which the
// handler turns into `null`, which the server stores, so every subsequent save
// WIPES the recorded name while the form still looks like it works. Dropping
// (3) does the same thing one step earlier: the field renders blank, and blank
// saves as null.
//
// A source grep (the public-meeting-contact.guard.test.ts pattern): the member
// form is a route file and the repo has no route-render tests, the server
// halves are covered by integration tests that call `applyMemberEdit`/
// `applyUpdateGuest` directly, and this wiring sits between the two where no
// existing test can see it.
//
// The GUEST form moved out of `_authed/admin/vp-membership.tsx` into the shared
// `components/club/guest-edit-dialog.tsx` at #727, when the meeting page's
// attendance rail became a second caller. This guard is the reason the move had
// to be a LIFT rather than a copy: it reads ONE file per form, so a second copy
// of the guest form would have been unguarded, and the failure it guards
// against is silent — a mismatch makes `form.get` return null, the handler
// sends null, and every save wipes the stored name while the form still looks
// like it works.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));

/** Every non-test `.tsx` under `root` whose RAW source contains `needle`,
 *  as paths relative to `root` with forward slashes. */
function filesContaining(root: string, needle: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") walk(full);
			} else if (
				entry.name.endsWith(".tsx") &&
				!entry.name.includes(".test.")
			) {
				if (readFileSync(full, "utf8").includes(needle)) {
					out.push(relative(root, full).split("\\").join("/"));
				}
			}
		}
	};
	walk(root);
	return out;
}
/**
 * Comments are blanked FIRST (see `#/test/guard-source`), then whitespace is
 * collapsed so Biome's line-wrapping can't fool the matches. The order is
 * load-bearing in both directions: these are "must BE present" assertions that
 * a comment would otherwise satisfy, and collapsing whitespace first would fuse
 * comment prose into the surrounding code text and manufacture matches that
 * exist in neither.
 */
const read = (rel: string) =>
	readSource(resolve(ROUTES, rel)).replace(/\s+/g, "");

/** The two forms that let a human record what someone is called. */
const FORMS = [
	{
		file: "_authed/members.$id.tsx",
		what: "member",
		// The loader row the field is seeded from (getMemberProfile's `member`).
		row: "member",
	},
	{
		// NOT `_authed/admin/vp-membership.tsx` any more (#727). The form lives in
		// the shared dialog; VP Membership and the meeting rail both render it.
		file: "../components/club/guest-edit-dialog.tsx",
		what: "guest",
		row: "guest",
	},
];

describe("the Goes by field round-trips (#486)", () => {
	for (const { file, what, row } of FORMS) {
		it(`${file} reads the ${what} field back under the name it renders it with`, () => {
			const src = read(file);
			// The key the submit handler actually reads.
			const key = /preferredName:String\(form\.get\("([^"]+)"\)/.exec(src)?.[1];
			expect(
				key,
				`${file} no longer builds its preferredName payload from form.get(); ` +
					"if the form moved to a different mechanism, update this guard.",
			).toBeTruthy();
			// …must be the name an input on this form is submitted under.
			expect(
				src,
				`${file} submits FormData key "${key}" but renders no input named ` +
					`"${key}". form.get() would return null, the handler would send ` +
					"null, and every save would silently wipe the stored name.",
			).toContain(`name="${key}"`);
		});

		it(`${file} seeds the ${what} field from the stored value`, () => {
			const src = read(file);
			expect(
				src,
				`${file} must render the stored ${row}.preferredName as the field's ` +
					"defaultValue — an unseeded field is blank, and blank saves as null.",
			).toContain(`defaultValue={${row}.preferredName??""}`);
		});
	}

	it("finds the forms it claims to guard (so a route rename can't make this vacuous)", () => {
		for (const { file } of FORMS) {
			expect(read(file)).toContain("preferredName");
		}
	});

	it("there are exactly TWO of these forms in the tree (#727)", () => {
		// The census, and the reason #727 had to LIFT the guest form rather than
		// copy it. This guard reads ONE file per form, so a third copy anywhere —
		// the obvious shortcut when a second surface wants the same dialog — would
		// be completely unguarded, and its failure mode is silent and destructive:
		// a `name` / `form.get` mismatch makes the save send `null`, wiping the
		// stored value while the form still looks like it works.
		//
		// Reads RAW, not comment-blind: this is an offender-list sweep, so a
		// comment quoting the attribute can only ever ADD a false offender (a loud
		// failure, the safe direction), while blanking comments could LOOSEN it.
		const found = filesContaining(
			resolve(ROUTES, ".."),
			'name="preferredName"',
		);
		expect(
			found.sort(),
			"a third copy of the goes-by form appeared. This guard reads one file " +
				"per form, so the new copy is unguarded — import the shared component " +
				"instead, or add it to FORMS above and say why a third form exists.",
		).toEqual(
			[
				"components/club/guest-edit-dialog.tsx",
				"routes/_authed/members.$id.tsx",
			].sort(),
		);
	});
});
