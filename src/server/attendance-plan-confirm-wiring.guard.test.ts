import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * `setPlannedAttendance`'s half of #908: "I'll be there" on the personal page
 * also confirms the member's claimed roles.
 *
 * The confirm itself (`confirmHeldClaimedSlots`) is executed against a real
 * database in `slots-confirm.integration.test.ts`. What that suite cannot reach
 * is the handler that decides WHEN it runs — a `createServerFn` body is not
 * invocable from vitest — and the three decisions there are each a way to get
 * this wrong with every behavioural test green:
 *
 *  - the confirm runs only AFTER the answer is written, so a slot that moved
 *    concurrently can never cost the member their `coming`, and an answer
 *    ADR-0026 refuses has already thrown before anything is confirmed;
 *  - it is OPT-IN on the wire and defaults off, so a tab open across the deploy
 *    keeps getting exactly the write it always got;
 *  - it runs only when the resolved actor IS the member, because the holder arm
 *    credits the holder as `grantedVia: "self"` — an officer or Toastmaster
 *    answering for someone must not have it recorded as the member's own yes.
 */
const SRC = readSource(resolve(__dirname, "attendance-plan.ts"));

function handlerBody(name: string): string {
	const start = SRC.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) throw new Error(`${name} not found in attendance-plan.ts`);
	const next = SRC.indexOf("\nexport const", start + 1);
	return SRC.slice(start, next === -1 ? SRC.length : next);
}

describe("setPlannedAttendance confirms held roles (#908)", () => {
	const body = handlerBody("setPlannedAttendance");

	it("defaults the opt-in to FALSE on the wire", () => {
		expect(SRC).toContain("confirmHeldRoles: z.boolean().default(false)");
	});

	it("confirms only for coming, only when asked, only for the member themself", () => {
		expect(body).toMatch(
			/data\.status === "coming" &&\s*data\.confirmHeldRoles &&\s*actorMemberId === data\.memberId\s*\?/,
		);
	});

	it("confirms only AFTER each answer write, never before", () => {
		// Two answer writes (fill-blank and floored), each returned beside the
		// confirm. The confirm is invoked from those two returns and nowhere
		// else, and each sits after its own `setPlanStatus`.
		const calls = body.split("await confirmIfAsked()").length - 1;
		expect(calls).toBe(2);
		const writes: number[] = [];
		let at = body.indexOf("await setPlanStatus(db,");
		while (at !== -1) {
			writes.push(at);
			at = body.indexOf("await setPlanStatus(db,", at + 1);
		}
		expect(writes).toHaveLength(2);
		let from = 0;
		for (const write of writes) {
			const confirm = body.indexOf("await confirmIfAsked()", from);
			expect(confirm).toBeGreaterThan(write);
			from = confirm + 1;
		}
	});

	it("never confirms on the decline branch", () => {
		const decline = body.slice(
			body.indexOf('if (data.status === "not_coming")'),
			body.indexOf("await resolveActor("),
		);
		expect(decline).not.toContain("confirmHeldClaimedSlots");
		expect(decline).not.toContain("confirmIfAsked");
	});

	it("clearPlannedAttendance does not accept the flag", () => {
		expect(handlerBody("clearPlannedAttendance")).toContain(
			"confirmHeldRoles: true",
		);
	});
});
