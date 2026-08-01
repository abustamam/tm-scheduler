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
// A source grep (the public-meeting-contact.guard.test.ts pattern) because
// these are route files: the repo has no route-render tests, the server halves
// are covered by integration tests that call `applyMemberEdit`/
// `applyUpdateGuest` directly, and this wiring sits between the two where no
// existing test can see it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));
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
		file: "_authed/admin/vp-membership.tsx",
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
});
