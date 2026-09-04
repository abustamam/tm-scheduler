/**
 * Validator-level tests for the per-meeting agenda editor's `updateAgendaRowFn`
 * (regression closed on this branch, #522-shaped).
 *
 * A whole-branch review added zod bounds (`.max()`, `.min()`, `.int()`) to
 * `patchInput` with no message argument. `ZodError.message` is
 * `JSON.stringify(issues, null, 2)` — the whole issues array, `code` and
 * `path` included — and the editor route does no error mapping
 * (`club.$clubId.meeting.$meetingId_.agenda.tsx`) before `runAction`
 * (`agenda-editor.tsx`) toasts `err.message` verbatim. So tripping any of
 * those bounds put a raw JSON dump in front of a club officer.
 *
 * `meeting-agenda-edit-logic.integration.test.ts` cannot catch this: it
 * drives `updateAgendaRow` (the -logic function) directly with an
 * already-parsed patch object, and mocks the rejection with the friendly
 * string when it wants one — it never goes through `patchInput`/zod at all,
 * so a message-less bound is invisible to it.
 *
 * These tests instead drive the REAL exported `updateAgendaRowFn`, including
 * its real `.validator()` and the `fallbackMessage`/`parse` helpers that
 * back it. `patchInput` is intentionally NOT exported —
 * `server-modules.guard.test.ts` forbids a server-fn module from exporting
 * anything but `createServerFn`s and types, since a plain value export here
 * would drag `#/db` into the client bundle. Calling `updateAgendaRowFn(...)`
 * directly fails outside a real request ("No Start context found in
 * AsyncLocalStorage"), so this reaches inside one call further: TanStack
 * Start's own `__executeServer` is what runs the validator server-side, and
 * `runWithStartContext` (the same package `createServerFn` itself uses to
 * read that context) is what lets a test stand one up without a live
 * request. No session, no request context beyond that stub, and no database
 * are needed for a value the validator itself refuses before the (otherwise
 * DB-touching) handler ever runs.
 *
 * `#/db` is mocked to a dead stub rather than the real test client: nothing
 * here reaches a query.
 */
import {
	runWithStartContext,
	type StartStorageContext,
} from "@tanstack/start-storage-context";
import { describe, expect, it, vi } from "vitest";
import { MAX_BEAT_MINUTES } from "#/lib/meeting-template-limits";

vi.mock("#/db", () => ({ db: {} }));

const { updateAgendaRowFn } = await import("./meeting-agenda-edit");

/** True for a human sentence; false for a `ZodError.message` JSON dump —
 *  `"code"` and `"path"` are two of the keys every issue object carries. */
function looksLikeJsonDump(message: string): boolean {
	return message.includes('"code"') || message.includes('"path"');
}

/** Fake just enough of TanStack Start's per-request context for
 *  `__executeServer` to run the real validator with no live request. Only
 *  `contextAfterGlobalMiddlewares` and `request` are actually read on this
 *  path; `getRouter` is never called for a rejected patch, so it throws if
 *  that assumption ever stops holding. */
const fakeStartContext: StartStorageContext = {
	getRouter: () => {
		throw new Error("fakeStartContext.getRouter should not be called here");
	},
	request: new Request("http://localhost/"),
	startOptions: {},
	contextAfterGlobalMiddlewares: {},
	executedRequestMiddlewares: new Set(),
	handlerType: "serverFn",
};

/** The raw server-fn outcome, so a case can assert ACCEPTANCE rather than only
 *  a different refusal sentence. */
async function patchOutcome(patch: Record<string, unknown>) {
	return (await runWithStartContext(fakeStartContext, () =>
		updateAgendaRowFn.__executeServer({
			method: "POST",
			data: {
				meetingId: "00000000-0000-0000-0000-000000000000",
				rowId: "00000000-0000-0000-0000-000000000000",
				patch,
			},
		}),
	)) as { error?: { message: string } };
}

async function rejectionMessage(patch: Record<string, unknown>) {
	const { error } = await patchOutcome(patch);
	if (!error) throw new Error("expected updateAgendaRowFn to reject");
	return error.message;
}

describe("updateAgendaRowFn's patch validator rejects with a human message", () => {
	it("minutes over the cap: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ minutes: MAX_BEAT_MINUTES + 1 });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toBe(`Minutes must be between 0 and ${MAX_BEAT_MINUTES}.`);
	});

	it("minutes below zero: same sentence as over-the-cap", async () => {
		const message = await rejectionMessage({ minutes: -1 });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toBe(`Minutes must be between 0 and ${MAX_BEAT_MINUTES}.`);
	});

	it("a fractional minutes value: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ minutes: 3.5 });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toMatch(/whole number/i);
	});

	it("markGreen over the cap: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({
			markGreen: MAX_BEAT_MINUTES + 1,
		});
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toBe(
			`Green mark must be between 0 and ${MAX_BEAT_MINUTES}.`,
		);
	});

	it("markYellow below zero: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ markYellow: -1 });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toBe(
			`Yellow mark must be between 0 and ${MAX_BEAT_MINUTES}.`,
		);
	});

	it("ACCEPTS a fractional mark — the columns are real(), not integer", async () => {
		// This case asserted the opposite until #679 (`markRed: 2.2` had to be
		// refused with "whole number"), on a comment claiming a float "reached an
		// `integer` column". It does not: `mark_green/mark_yellow/mark_red` are
		// `real()`, and 2.5 is a value this app itself stores — `EVALUATION_MARKS`
		// is 2 / 2.5 / 3, so every materialised evaluation beat holds one. The
		// `.int()` made a legal stored value unwritable through the only path that
		// writes one: the editor's inputs refused 2.5, and Undo on a deleted
		// evaluation row replayed the stored 2.5 and failed AFTER the placeholder
		// was inserted, losing the officer's row.
		//
		// Asserted as ACCEPTANCE, not as a different rejection sentence: the patch
		// clears the validator outright here, so `rejectionMessage` would throw its
		// own "expected to reject" and a test written that way could never say
		// which layer let the value through.
		// `error` is a KEY that is present-but-undefined on success, so this asks
		// about its VALUE — `not.toHaveProperty("error")` passes on a rejection.
		expect((await patchOutcome({ markRed: 2.2 })).error).toBeFalsy();
		// The neighbouring bound is untouched — dropping `.int()` must not drop the
		// range with it.
		expect(await rejectionMessage({ markRed: MAX_BEAT_MINUTES + 1 })).toBe(
			`Red mark must be between 0 and ${MAX_BEAT_MINUTES}.`,
		);
	});

	it("still refuses a NON-numeric mark, readably", async () => {
		// Dropping `.int()` must not drop the type check with it.
		const message = await rejectionMessage({ markRed: "soon" });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toBe("Red mark must be a number.");
	});

	it("an over-long label: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ label: "x".repeat(10_000) });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toMatch(/^Keep the label under \d+ characters\.$/);
	});

	it("an over-long detail: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ detail: "x".repeat(10_000) });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toMatch(/^Keep the note under \d+ characters\.$/);
	});

	it("an over-long roleKey: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ roleKey: "x".repeat(10_000) });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toMatch(/^Keep the role reference under \d+ characters\.$/);
	});

	it("an over-long repeatsRoleKey: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({
			repeatsRoleKey: "x".repeat(10_000),
		});
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toMatch(
			/^Keep the repeat-role reference under \d+ characters\.$/,
		);
	});
});
