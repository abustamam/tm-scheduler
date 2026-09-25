/**
 * The `key` a club-owned template is saved under (#909).
 *
 * Pure, and in `lib/` rather than beside the writer, so the derivation is
 * testable without a database. The writer (`nextClubTemplateKey` in
 * `meeting-templates-logic.ts`) supplies the club's taken keys, read inside its
 * transaction under a lock on the club row; `meeting_templates_club_key_unique`
 * stays the backstop.
 *
 * Hyphens, never underscores: GLOBAL template keys are `snake_case`
 * (`speech_contest`), and a private copy keeps its SOURCE's key. Keeping the two
 * alphabets apart means a club naming a template "Speech contest" can never mint
 * the same key a copy of the global one carries.
 */

import { MAX_TEMPLATE_DETAIL_CHARS } from "#/lib/meeting-template-limits";

/** Name bound for a saved club template, in code points after trimming. Here
 *  rather than beside the writer so the dialog can import it too. */
export const CLUB_TEMPLATE_NAME_MAX = 80;

/** Description bound — the same ceiling a beat's detail carries. */
export const CLUB_TEMPLATE_DESCRIPTION_MAX = MAX_TEMPLATE_DETAIL_CHARS;

/**
 * The key a superseded private copy is parked under for the instant between
 * being detached and deleted (`applyTemplateConversion`). Built from
 * characters a slug CANNOT contain — `_` and `:` are outside `[a-z0-9-]` — so
 * no club template named anything can already hold it. (`retired-<id>` could
 * be minted by a club naming a template exactly that, and then block that
 * meeting's every later conversion on the club-key index.)
 */
export const RETIRED_TEMPLATE_KEY_PREFIX = "_retired:";

export function retiredTemplateKey(templateId: string): string {
	return `${RETIRED_TEMPLATE_KEY_PREFIX}${templateId}`;
}

/** Longest slug before a `-N` suffix is appended. */
export const CLUB_TEMPLATE_KEY_MAX = 60;

/** What an empty slug becomes — a name made only of punctuation or non-Latin
 *  script still needs a key. */
export const CLUB_TEMPLATE_KEY_FALLBACK = "template";

/**
 * Lowercase ASCII slug of a template's name: every run of characters outside
 * `[a-z0-9]` becomes one `-`, leading and trailing `-` are trimmed, and the
 * result is cut to `CLUB_TEMPLATE_KEY_MAX` (re-trimmed, so a cut never leaves a
 * trailing `-`). Accented Latin letters fold to their base letter first, so
 * "Café night" is `cafe-night` rather than `caf-night`.
 */
export function clubTemplateKeySlug(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, CLUB_TEMPLATE_KEY_MAX)
		.replace(/-+$/g, "");
	return slug === "" ? CLUB_TEMPLATE_KEY_FALLBACK : slug;
}

/**
 * The first of `slug`, `slug-2`, `slug-3`… that `taken` does not hold.
 *
 * Starts at 2, not 1: the first save of a name gets the bare slug, so the
 * second "Contest night" is `contest-night-2` — the numbering a reader expects.
 */
export function firstFreeClubTemplateKey(
	slug: string,
	taken: ReadonlySet<string>,
): string {
	if (!taken.has(slug)) return slug;
	for (let n = 2; ; n++) {
		const candidate = `${slug}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}
