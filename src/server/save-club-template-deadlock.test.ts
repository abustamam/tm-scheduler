/**
 * A deadlock inside the club-template save reaches the officer as the same
 * retryable sentence a first-edit fork shows, never as the driver's
 * `Failed query: …` (#909 review 2). Unit-level: the transaction is stubbed to
 * fail the way drizzle hands a `pg` error back — the SQLSTATE on `cause`.
 */
import { describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
vi.mock("#/db", () => ({ db: { transaction: () => transaction() } }));

const INPUT = {
	mode: "new" as const,
	meetingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	clubId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	actorMemberId: null,
	name: "Contest night",
	description: null,
};

function driverError(code: string): Error {
	return new Error('Failed query: select "id" from "clubs" …', {
		cause: Object.assign(new Error("pg"), { code }),
	});
}

async function saveFailingWith(err: Error): Promise<unknown> {
	const { saveMeetingAgendaAsClubTemplate } = await import(
		"./meeting-templates-logic"
	);
	transaction.mockImplementation(async () => {
		throw err;
	});
	try {
		await saveMeetingAgendaAsClubTemplate(INPUT);
	} catch (caught) {
		return caught;
	}
	throw new Error("the save did not fail");
}

describe("saveMeetingAgendaAsClubTemplate's deadlock translation", () => {
	it("turns a 40P01 into the editor's try-again sentence", async () => {
		const { AGENDA_DEADLOCK_MESSAGE } = await import(
			"./meeting-agenda-edit-logic"
		);
		const caught = await saveFailingWith(driverError("40P01"));
		expect((caught as Error).message).toBe(AGENDA_DEADLOCK_MESSAGE);
	});

	it("leaves every other failure alone", async () => {
		const other = driverError("23505");
		expect(await saveFailingWith(other)).toBe(other);
	});
});
