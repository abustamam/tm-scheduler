/**
 * The evaluation requests of the walk (#1047, fourth review round). They are JSON, so no page
 * shows who they were answered for, and they are best-effort, so a bad one must not poison Resume.
 *
 *  - the batch is fenced between two identity-checked HTML requests (`my_evaluations.php` before,
 *    and again after): if the account changed in between, nothing of the batch is kept;
 *  - a detail the parser cannot read is a page-shape failure, never cached, so Resume asks again;
 *    a genuine bug in the parser still surfaces.
 * Run: cd extension && bunx vitest run lib/easy-speak-walk-evaluations.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import {
	FIXTURE_IDENTITY,
	clock,
	memoryStore,
	setup,
} from "./easy-speak-test-kit";
import type { Identity } from "./easy-speak-walk";

// Every real parser, except that a test can make `parseEvaluation` throw a programming error.
vi.mock("./easy-speak-parse", async (importOriginal) => {
	const real = await importOriginal<typeof import("./easy-speak-parse")>();
	return { ...real, parseEvaluation: vi.fn(real.parseEvaluation) };
});
import { parseEvaluation } from "./easy-speak-parse";

const other: Identity = { ...FIXTURE_IDENTITY, username: "someoneelse" };
const SECRET = "text only the other account sees";
const LIST = "/api/v1/evaluations.php/my-evaluations";
const OTHERS_DETAIL = JSON.stringify({
	evaluation: { responses: [{ field_type: "text", field_label: "Note", text_value: SECRET }] },
});
const pages = (store: ReturnType<typeof memoryStore>) => [...store.data.keys()].filter((k) => k.startsWith("page:"));

/** The store keeps everything when the walk ends, as if the tab were reloaded just before the cleanup. */
function keepAtEnd(store: ReturnType<typeof memoryStore>) {
	const real = store.transact;
	store.transact = async (keys, fn) =>
		real(keys, (cur) => {
			const w = fn(cur);
			return w?.clear && !w.set ? undefined : w;
		});
}

/** A site that answers as `other` from the request for the evaluation list (or detail `from`) on. */
function switchesAt(from: "list" | "detail", flag: { on: boolean }) {
	return {
		as: (_i: number, url: string): Identity => {
			if (url.endsWith(from === "list" ? LIST : "/eval/502")) flag.on = true;
			return flag.on ? other : FIXTURE_IDENTITY;
		},
		override: (url: string) => (flag.on && /\/eval\/\d+$/.test(url) ? OTHERS_DETAIL : undefined),
	};
}

describe("the evaluation requests are fenced on the account", () => {
	for (const from of ["list", "detail"] as const) {
		it(`keeps nothing of the evaluations, and ends the walk, when the account switches at the evaluation ${from}`, async () => {
			const store = memoryStore();
			const s = setup({ store, ...switchesAt(from, { on: false }) });
			await expect(s.run()).rejects.toThrow(/signed in as another account/);
			// Not forgiven as "evaluations skipped"; the closing check was the last request.
			expect(s.progress.some((l) => /evaluations skipped/.test(l))).toBe(false);
			expect(new URL(s.log[s.log.length - 1].url).pathname).toBe("/my_evaluations.php");
			// Nothing the other account answered is in the store, and none of the batch's entries are.
			expect(JSON.stringify([...store.data.entries()])).not.toContain(SECRET);
			expect(pages(store).filter((k) => k.includes("evaluation") && k !== "page:evaluations-page")).toEqual([]);
			// The session's page count agrees with what is stored.
			expect((store.data.get("meta") as { pages: number }).pages).toBe(pages(store).length);
		});
	}

	it("resumes after switching back: the evaluations are asked for again, from the right account", async () => {
		const store = memoryStore();
		const flag = { on: false };
		const first = setup({ store, ...switchesAt("list", flag) });
		await expect(first.run()).rejects.toThrow(/another account/);
		flag.on = false;
		const second = setup({ store, clock: first.c });
		const { bundle } = await second.run();
		const asked = second.log.map((r) => new URL(r.url).pathname);
		expect(asked).toContain(LIST);
		expect(asked).toContain("/api/v1/evaluations.php/eval/501");
		expect(asked).not.toContain("/clubdata.php");
		expect(bundle.evaluations.map((e) => e.esId).sort()).toEqual(["501", "502"]);
		expect(JSON.stringify(bundle)).not.toContain(SECRET);
	});

	it("asks the closing question of the site itself on a resume, even with every evaluation cached", async () => {
		const store = memoryStore();
		keepAtEnd(store);
		const c = clock();
		const first = setup({ store, clock: c });
		await first.run();
		expect(store.data.has("page:evaluation:502")).toBe(true);
		// The account changed after the batch was stored, before this run's only request.
		const second = setup({ store, clock: c, as: (_i, url) => (url.endsWith("/my_evaluations.php") ? other : FIXTURE_IDENTITY) });
		await expect(second.run()).rejects.toThrow(/another account/);
		expect(second.log.map((r) => new URL(r.url).pathname)).toEqual(["/my_evaluations.php"]);
	});

	it("paces the closing request like any other: at least a second after the one before", async () => {
		const s = setup();
		await s.run();
		const [last, before] = [...s.log].reverse();
		expect(new URL(last.url).pathname).toBe("/my_evaluations.php");
		expect(last.startedAt - before.startedAt).toBeGreaterThanOrEqual(1000);
	});
});

describe("an evaluation the parser cannot read", () => {
	const unreadable = (url: string) => (url.endsWith("/eval/501") ? JSON.stringify({ evaluation: { responses: [null] } }) : undefined);

	it("is not cached, so Resume asks for it again and succeeds once the server is fixed", async () => {
		const store = memoryStore();
		keepAtEnd(store);
		const c = clock();
		const first = setup({ store, clock: c, override: unreadable });
		const { bundle: partial } = await first.run();
		// Best-effort: no evaluations, a note naming the evaluation, and the rest of the export intact.
		expect(partial.evaluations).toEqual([]);
		expect(partial.meetings).toHaveLength(3);
		expect(first.progress.some((l) => /evaluations skipped: evaluation 501 is not the Easy-Speak page/.test(l))).toBe(true);
		expect(store.data.has("page:evaluation:501")).toBe(false);

		const second = setup({ store, clock: c });
		const { bundle } = await second.run();
		const asked = second.log.map((r) => new URL(r.url).pathname);
		expect(asked).toContain("/api/v1/evaluations.php/eval/501");
		expect(asked).not.toContain("/clubdata.php");
		expect(bundle.evaluations.map((e) => e.esId).sort()).toEqual(["501", "502"]);
	});

	it("is read as 'not a list of responses' too", async () => {
		const s = setup({
			override: (url) => (url.endsWith("/eval/502") ? JSON.stringify({ evaluation: { responses: { 0: {} } } }) : undefined),
		});
		const { bundle } = await s.run();
		expect(bundle.evaluations).toEqual([]);
		expect(s.progress.some((l) => /evaluation 502 is not the Easy-Speak page.*not a list/.test(l))).toBe(true);
	});

	it("still lets a genuine bug in the parser surface, and keeps the page out of the store", async () => {
		const store = memoryStore();
		vi.mocked(parseEvaluation).mockImplementationOnce(() => {
			throw new TypeError("a bug, not a bad response");
		});
		await expect(setup({ store }).run()).rejects.toThrow(TypeError);
		expect(store.data.has("page:evaluation:501")).toBe(false);
	});
});
