/**
 * What must stay in `releaseSlot`'s handler after #809 moved the rest out.
 *
 * The extraction to `releaseSlotCore` was worth making because a handler body
 * is unreachable from vitest: the archive gate, the lock check and the write
 * are now EXECUTED by `public-writers-archive-gate.integration.test.ts`
 * instead of merely grepped for.
 *
 * An earlier draft of this sentence also named `slots-release.integration.test.ts`,
 * which has never existed. That is the failure `CODING_STANDARDS.md` calls out
 * as uncatchable by mutation — a confident claim about coverage, checkable in
 * one `find`, false on the day it was written — and it was the sentence
 * justifying the extraction. Cite a suite only after opening it. The two
 * assertions here are about the half that could NOT move, and each pins a
 * different failure.
 *
 * **`requestWriteActor` stays in the handler.** It is a REQUEST-scoped read —
 * it resolves the caller's session, if any, and credits them rather than the
 * member id they asserted (#396) — and `assign_roles` reaches the same core
 * with an actor resolved from a bearer token. Pulling the resolution into the
 * core would make the seam unreachable from the MCP path, and the failure would
 * be silent in the direction that matters: `actorMemberId` would fall back to
 * something, and the activity log would credit the wrong person for an
 * anonymous release. A source guard because a `createServerFn` handler cannot
 * be invoked from vitest at all — the same reason the gate was only ever
 * grepped for before this change.
 *
 * **The handler must not keep writing the slot itself.** The danger in an
 * extraction is the copy that stays behind: a handler still running its own
 * UPDATE would pass every behavioural test, because the observable end state is
 * identical — and it would do it without the row lock the core takes, which is
 * the entire point of the move. So this asserts the write is GONE from the
 * handler, which is the "must be ABSENT" class and reads RAW: stripping
 * comments could only hide a real UPDATE inside one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = "src/server/slots.ts";
const CORE_SRC = "src/server/slots-logic.ts";

/**
 * The `releaseSlot` handler body, sliced to its own declaration.
 *
 * Stops at the next top-level `const`, so a sibling server fn's
 * `requestWriteActor` — `claimSlot` and `reassignSlot` both call it — can never
 * be miscredited to this one. That is the body-slicing lesson #565 recorded,
 * and it is not hypothetical here: every neighbour in this file satisfies the
 * positive assertion below.
 */
function releaseSlotBody(source: string): string {
	const start = source.indexOf("export const releaseSlot = createServerFn");
	expect(start, `no releaseSlot declaration in ${SRC}`).toBeGreaterThan(-1);
	const rest = source.slice(start + 1);
	const nextDecl = rest.search(
		/\n(?:export )?const |\n(?:export )?(?:async )?function /,
	);
	return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

/** The `releaseSlotCore` body, sliced to its own declaration. */
function releaseSlotCoreBody(): string {
	const src = readSource(CORE_SRC);
	const start = src.indexOf("export async function releaseSlotCore");
	expect(
		start,
		`no releaseSlotCore declaration in ${CORE_SRC}`,
	).toBeGreaterThan(-1);
	const rest = src.slice(start + 1);
	const nextDecl = rest.search(
		/\n(?:export )?(?:async )?function |\ntype |\nconst /,
	);
	return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe("releaseSlot keeps only what cannot move into the seam (#809)", () => {
	it("slices the handler without running into its neighbours", () => {
		// The floor that makes both cases below mean something: an over-capturing
		// slice lends `claimSlot`'s call to this one and the positive passes for
		// the wrong reason, while an empty slice passes the negative vacuously.
		const body = releaseSlotBody(readSource(SRC));
		expect(body.length).toBeGreaterThan(200);
		expect(body).toContain("releaseSchema.parse");
		expect(body).not.toContain("confirmSchema");
		expect(body).not.toContain("claimSchema");
	});

	it("resolves the actor through requestWriteActor", () => {
		// "Must BE present", so comment-blind: prose naming the call is not it.
		expect(
			releaseSlotBody(readSource(SRC)),
			"releaseSlot is a session-less write and `requestWriteActor` is what " +
				"credits a signed-in caller as themselves rather than the member id " +
				"they asserted (#396). It cannot move into `releaseSlotCore` — that " +
				"read is request-scoped and `assign_roles` calls the same core from a " +
				"bearer token. Restore the call here.",
		).toContain("requestWriteActor(");
	});

	/**
	 * The lock is the reason the extraction is not merely a tidy-up, and it has
	 * no observable of its own: without it a release still produces the same end
	 * state in every serial test, and the difference only appears when a
	 * concurrent reassign interleaves between the read and the write. Reaching
	 * that from vitest means winning a race on purpose — a flaky test rather
	 * than a gate, which is the same argument `confirm-slot-race.guard.test.ts`
	 * makes for pinning its clause in source.
	 *
	 * `OF role_slots` matters as much as the lock: the joined `meetings` row
	 * does not change under us, and locking it would serialize every slot edit
	 * on the meeting against every other.
	 */
	it("takes the FOR UPDATE row lock, on role_slots alone", () => {
		const body = releaseSlotCoreBody();
		expect(body.length).toBeGreaterThan(200);
		expect(
			body,
			"releaseSlotCore reads the slot without a row lock, so a concurrent " +
				"reassign between its read and its write is silently overwritten — " +
				"and inside an assign_roles batch it is a check-then-act in a " +
				"sequence that is otherwise lock-serialized.",
		).toMatch(/\.for\(\s*"update"\s*,\s*\{\s*of:\s*roleSlots\s*\}\s*\)/);
	});

	it("delegates the write instead of keeping a copy", () => {
		// RAW, per `guard-source.ts`: this is the "must be ABSENT" class, and a
		// stripped read could only hide a real UPDATE inside a comment.
		const raw = readFileSync(resolve(process.cwd(), SRC), "utf8");
		const body = releaseSlotBody(raw);
		expect(
			body,
			"releaseSlot must delegate to releaseSlotCore, which takes the FOR " +
				"UPDATE row lock. A copy of the UPDATE left in the handler passes " +
				"every behavioural test — the end state is identical — while doing " +
				"the write unlocked.",
		).toContain("releaseSlotCore(");
		expect(
			/\.update\(\s*roleSlots\s*\)/.test(body),
			"releaseSlot still updates role_slots in the handler, outside the row lock the core takes.",
		).toBe(false);
	});
});
