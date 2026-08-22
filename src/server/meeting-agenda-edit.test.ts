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

async function rejectionMessage(patch: Record<string, unknown>) {
	const outcome = await runWithStartContext(fakeStartContext, () =>
		updateAgendaRowFn.__executeServer({
			method: "POST",
			data: {
				meetingId: "00000000-0000-0000-0000-000000000000",
				rowId: "00000000-0000-0000-0000-000000000000",
				patch,
			},
		}),
	);
	const { error } = outcome as { error?: { message: string } };
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

	it("markRed not an integer: readable, not a JSON dump", async () => {
		const message = await rejectionMessage({ markRed: 2.2 });
		expect(looksLikeJsonDump(message)).toBe(false);
		expect(message).toMatch(/whole number/i);
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
