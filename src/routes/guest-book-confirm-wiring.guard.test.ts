/**
 * The confirm route hands the table the right things (#806).
 *
 * A route component is the other place in this repo a vitest assertion cannot
 * reach: rendering it needs a router context, and `guest-book.$planId.tsx` owns
 * the optimistic draft state, the two server-fn calls and the error catch. The
 * component test beside it covers `ConfirmEntriesTable`, and the integration
 * suite covers every decision in `guest-book-pending-logic.ts` — the CALL SITE
 * between them is what neither can see, and #319 is the standing example of a
 * defect that lived in exactly that gap with both sides well covered.
 *
 * This PR has its own example. `patchSchema` shipped with a duplicate
 * discriminator that broke every edit on this page, with typecheck, lint and
 * 7,600 tests green, and it was found by opening the page in a browser. The
 * properties below are the ones a regression here would silently change.
 *
 * Read COMMENT-BLIND: this file's subject carries long comments that quote its
 * own JSX, and matching one would pin documentation rather than the shipped
 * call. Per `src/test/guard-source.ts` that is the right reader for a
 * "must BE present" guard.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"_authed/guest-book.$planId.tsx",
);

const src = readSource(ROUTE);

/** The `<ConfirmEntriesTable …/>` call site, sliced to its own tag. */
function tableTag(): string {
	const at = src.indexOf("<ConfirmEntriesTable");
	expect(
		at,
		"the confirm route no longer renders ConfirmEntriesTable",
	).toBeGreaterThan(-1);
	return src.slice(at, src.indexOf("/>", at));
}

describe("the guest-book confirm route's wiring (#806)", () => {
	const tag = tableTag();

	it("finds the table call site to check", () => {
		// Vacuity floor: an empty slice would satisfy nothing below by having
		// nothing to search.
		expect(tag.length).toBeGreaterThan(80);
	});

	for (const prop of [
		"entries={view.entries}",
		"lines={view.lines}",
		"blocking={view.blocking}",
		"busy={busy}",
		"onEdit={runEdit}",
	]) {
		it(`passes ${prop}`, () => {
			expect(tag).toContain(prop);
		});
	}

	it("applies the hash the PAGE currently renders, not the loader's", () => {
		// The loader's hash is stale the moment any edit lands — every PATCH
		// re-plans and returns a fresh one. Applying `initial.planHash` would
		// refuse as PLAN_STALE after every correction, which is the failure the
		// whole edit flow exists to avoid.
		expect(src).toContain("planHash: view.planHash");
		expect(src).not.toContain("planHash: initial.planHash");
	});

	it("refuses to record while anything still blocks", () => {
		// The server refuses too (`applyGuestBookPlan` throws BLOCKED), so this
		// is the affordance rather than the gate — but a Record button that
		// looks live and always fails is worse than one that says why.
		expect(src).toContain("disabled={busy || problems > 0}");
	});

	it("reads and writes a draft through ONE key function", () => {
		// `draft` and `onDraft` addressing different keys would make a typed
		// value invisible to the box it was typed into. Both must go through
		// `draftKey`.
		expect(src).toContain("draft={(id, field) => drafts[draftKey(id, field)]}");
		expect(src).toContain("draftKey(id, field)]: value");
	});

	it("renders every page state the view can carry", () => {
		// `PendingPlanView` is a discriminated union; a status with no branch
		// falls through to the editable render, which reads `view.blocking` and
		// would crash. Typecheck catches the read, not the missing branch.
		for (const status of [
			"not_found",
			"archived",
			"expired",
			"applied",
			"unplannable",
		]) {
			expect(src, `no branch renders the "${status}" state`).toContain(
				`view.status === "${status}"`,
			);
		}
	});

	it("shows no visitor data on the applied tombstone", () => {
		// `entries` is nulled when the write lands, and the applied state has no
		// `entries` field at all — but a future edit could add one from the
		// header. Pin that the branch renders only the header fields.
		// Sliced to the branch's OWN end — the next `if (view.status ===` — not
		// to a character count. A fixed window ran into the `unplannable`
		// branch, which renders `view.entries` legitimately, so the assertion
		// failed on a neighbour's correct code. Same over-capture trap #565
		// records for `serverFnBody`.
		const at = src.indexOf('view.status === "applied"');
		expect(at).toBeGreaterThan(-1);
		const rest = src.slice(at);
		const next = rest.indexOf("if (view.status ===", 1);
		const branch = next === -1 ? rest : rest.slice(0, next);
		expect(branch).not.toContain("view.entries");
		expect(branch).not.toContain("view.lines");
	});
});
