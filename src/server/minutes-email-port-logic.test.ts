import { beforeEach, describe, expect, it, vi } from "vitest";

// The minutes email attaches the SAME PDF the download route serves, and its
// default recipient list includes every guest marked present at the meeting —
// a list an anonymous visitor can add themselves to, because `submitGuestBook`
// takes no session at all. Once the PDF started carrying club action items
// (#529), that made an internal list ("chase the lapsed members", "drop the
// venue") reachable by anyone who signed a guest book.
//
// The fix is one argument, which is exactly the kind of thing a refactor drops
// silently, so it is asserted here rather than left to review. The feature's own
// public-surface guard enumerates ROUTES and structurally cannot see this path.

const renderMinutesPdf = vi.fn(async () => new Uint8Array([1, 2, 3]));

vi.mock("#/db", () => ({ db: {} }));
vi.mock("./minutes-pdf-logic", () => ({ renderMinutesPdf }));

const { createMinutesEmailPort } = await import("./minutes-email-port-logic");

describe("minutes email PDF audience (#529)", () => {
	beforeEach(() => {
		renderMinutesPdf.mockClear();
	});

	it("asks for the GUEST view of the PDF", async () => {
		const port = createMinutesEmailPort();
		await port.renderMinutesPdf("meeting-1");

		expect(renderMinutesPdf).toHaveBeenCalledTimes(1);
		expect(renderMinutesPdf).toHaveBeenCalledWith("meeting-1", "guests");
	});

	it("never asks for the members-only view on the email path", async () => {
		// Pinned separately from the assertion above because the members view is
		// also the DEFAULT: dropping the argument entirely leaves a call that still
		// looks correct at the call site and quietly restores the leak.
		const port = createMinutesEmailPort();
		await port.renderMinutesPdf("meeting-1");

		const call = renderMinutesPdf.mock.calls[0] as unknown as [string, string?];
		expect(call?.[1]).toBeDefined();
		expect(call?.[1]).not.toBe("members");
	});
});
