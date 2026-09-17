/**
 * `matchGuest` — the guest dedup rule (#488 / ADR-0018), unit-tested over an
 * in-memory candidate set (#773 D7/D12).
 *
 * This is the rule three callers share: the public guest book at the door, the
 * officer adding a guest to past minutes, and the MCP guest-book transcription.
 * The table below IS the contract between them — a change here changes who two
 * of those paths think is the same visitor, so each row names the behaviour it
 * pins rather than just asserting an enum value.
 *
 * `guest-pipeline-logic.ts` imports `db` at module scope, so the module cannot
 * be imported without the mock; nothing here touches a database.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { matchGuest } = await import("./guest-pipeline-logic");
type Candidate = Parameters<typeof matchGuest>[0][number];

function guest(over: Partial<Candidate> & { id: string }): Candidate {
	return {
		name: "Jane Doe",
		email: null,
		phone: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		...over,
	};
}

describe("matchGuest — the outcome table (D7)", () => {
	it("matched: the email matches, case-insensitively", () => {
		const jane = guest({ id: "g1", email: "jane@example.com" });
		const m = matchGuest([jane], {
			name: "Jane Doe",
			email: "JANE@example.com",
			phone: null,
		});
		expect(m).toEqual({ outcome: "matched", via: "email", guest: jane });
	});

	it("matched: an email match wins even when the NAME disagrees", () => {
		// Email is the strong key — a married name or a nickname must not fork a
		// returning visitor into two prospects.
		const row = guest({
			id: "g1",
			name: "Jane Okafor",
			email: "j@example.com",
		});
		const m = matchGuest([row], {
			name: "Jane Doe",
			email: "j@example.com",
			phone: null,
		});
		expect(m.outcome).toBe("matched");
	});

	it("matched: the phone matches and the names agree", () => {
		const row = guest({ id: "g1", name: "Samir Patel", phone: "+15551234567" });
		const m = matchGuest([row], {
			name: "Samir Patel",
			email: null,
			phone: "+1 (555) 123-4567",
		});
		expect(m).toEqual({ outcome: "matched", via: "phone", guest: row });
	});

	it("new: no email match and no phone match", () => {
		const row = guest({ id: "g1", email: "someone@example.com" });
		expect(
			matchGuest([row], {
				name: "Nobody Here",
				email: "new@example.com",
				phone: null,
			}),
		).toEqual({ outcome: "new" });
	});

	it("new: an empty candidate set", () => {
		expect(
			matchGuest([], { name: "First Ever", email: "a@b.c", phone: null }),
		).toEqual({ outcome: "new" });
	});

	it("ambiguous: the phone matches but the names disagree (#488)", () => {
		// A spouse or coworker signing in with the shared number they already gave
		// is TWO prospects. The public path creates the second one; a transcriber
		// gets asked.
		const row = guest({ id: "g1", name: "Samir Patel", phone: "+15551234567" });
		const m = matchGuest([row], {
			name: "Priya Raman",
			email: null,
			phone: "+15551234567",
		});
		expect(m).toEqual({
			outcome: "ambiguous",
			reason: "phone_name_disagree",
			candidates: [row],
		});
	});

	it("ambiguous: a name-only entry whose name agrees — ONLY when asked for", () => {
		const row = guest({ id: "g1", name: "Sam Ray" });
		const input = { name: "Sam Ray", email: null, phone: null };

		// The public path must keep creating a new guest: a name is not a dedup
		// key, and two different Sam Rays are two prospects.
		expect(matchGuest([row], input)).toEqual({ outcome: "new" });

		// MCP planning asks instead of guessing.
		expect(matchGuest([row], input, { nameOnlyAmbiguity: true })).toEqual({
			outcome: "ambiguous",
			reason: "name_only",
			candidates: [row],
		});
	});

	it("nameOnlyAmbiguity does not fire when contact details were given", () => {
		// The entry HAS a phone; it just matches nothing. That is a new guest,
		// not a question — the name arm is for entries with nothing else to go on.
		const row = guest({ id: "g1", name: "Sam Ray" });
		expect(
			matchGuest(
				[row],
				{ name: "Sam Ray", email: null, phone: "+15550000000" },
				{ nameOnlyAmbiguity: true },
			),
		).toEqual({ outcome: "new" });
	});
});

describe("matchGuest — precedence and ordering", () => {
	it("email leads over phone", () => {
		// Pins the email-leads-over-phone order: both rows match on their own key,
		// and the email one must win regardless of which is older.
		const byPhone = guest({
			id: "g-phone",
			name: "Jane Doe",
			phone: "+15551234567",
			createdAt: new Date("2020-01-01T00:00:00.000Z"),
		});
		const byEmail = guest({
			id: "g-email",
			name: "Jane Doe",
			email: "jane@example.com",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		const m = matchGuest([byPhone, byEmail], {
			name: "Jane Doe",
			email: "jane@example.com",
			phone: "+15551234567",
		});
		expect(m).toMatchObject({ via: "email", guest: { id: "g-email" } });
	});

	it("takes the OLDEST of several matching rows, whatever order they arrive in", () => {
		// Without a total order a returning visitor's history splits
		// nondeterministically between duplicate rows.
		const older = guest({
			id: "b",
			email: "dup@example.com",
			createdAt: new Date("2020-01-01T00:00:00.000Z"),
		});
		const newer = guest({
			id: "a",
			email: "dup@example.com",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		const input = { name: "Jane Doe", email: "dup@example.com", phone: null };
		expect(matchGuest([newer, older], input)).toMatchObject({
			guest: { id: "b" },
		});
		expect(matchGuest([older, newer], input)).toMatchObject({
			guest: { id: "b" },
		});
	});

	it("breaks a createdAt tie on id, so the answer is stable", () => {
		const at = new Date("2026-01-01T00:00:00.000Z");
		const a = guest({ id: "aaa", email: "dup@example.com", createdAt: at });
		const b = guest({ id: "bbb", email: "dup@example.com", createdAt: at });
		const input = { name: "Jane Doe", email: "dup@example.com", phone: null };
		expect(matchGuest([b, a], input)).toMatchObject({ guest: { id: "aaa" } });
		expect(matchGuest([a, b], input)).toMatchObject({ guest: { id: "aaa" } });
	});

	it("honours excludeGuestId, so the edit path never clashes with itself", () => {
		const self = guest({ id: "me", email: "jane@example.com" });
		expect(
			matchGuest(
				[self],
				{ name: "Jane Doe", email: "jane@example.com", phone: null },
				{ excludeGuestId: "me" },
			),
		).toEqual({ outcome: "new" });
	});

	it("compares phones by digits, so formatting variants are one guest (#397)", () => {
		const row = guest({ id: "g1", name: "Samir Patel", phone: "+15551234567" });
		for (const typed of [
			"+15551234567",
			"+1 (555) 123-4567",
			"+1-555-123-4567",
		]) {
			expect(
				matchGuest([row], { name: "Samir Patel", email: null, phone: typed }),
			).toMatchObject({ outcome: "matched", via: "phone" });
		}
	});

	it("does NOT match two different countries' numbers sharing a suffix", () => {
		// The key is the digits of the FULL international number, not the last 10:
		// a suffix compare would merge +1 20 7946 0958 with +44 20 7946 0958.
		const uk = guest({ id: "g1", name: "Jane Doe", phone: "+442079460958" });
		expect(
			matchGuest([uk], {
				name: "Jane Doe",
				email: null,
				phone: "+12079460958",
			}),
		).toEqual({ outcome: "new" });
	});

	it("treats a blank email as no email rather than matching blank rows", () => {
		const blank = guest({ id: "g1", email: "" });
		expect(
			matchGuest([blank], { name: "Jane Doe", email: "  ", phone: null }),
		).toEqual({ outcome: "new" });
	});
});
