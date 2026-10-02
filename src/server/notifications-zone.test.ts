/**
 * #1017: the reminder's date is named in the CLUB's zone. The poller runs on
 * Railway's UTC container, so with no zone a 7pm meeting in Chicago (00:00 UTC
 * the next day) was announced for the NEXT day.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinIntlTo, restoreIntl } from "#/test/hydration-across-runtimes";

// The module reaches `#/db` on import. Nothing here touches it.
vi.mock("#/db", () => ({ db: {} }));

const { buildNotificationEmail } = await import("./notifications-logic");

afterEach(() => restoreIntl());

const ROW = {
	recipientName: "Ada Lovelace",
	roleName: "Timer",
	clubName: "Harbor City Toastmasters",
	// Tue Sep 15, 7pm in Chicago; already Wed Sep 16 in UTC.
	meetingScheduledAt: new Date("2026-09-16T00:00:00Z"),
	unsubscribeUrl: "https://gavelup.app/u/abc123",
};

describe("the reminder names the club's day (#1017)", () => {
	it("on a UTC server, an evening meeting is the club's day, not the next", () => {
		pinIntlTo("en-US", "UTC");
		const email = buildNotificationEmail({
			...ROW,
			clubTimezone: "America/Chicago",
		});
		expect(email.subject).toContain("Tue, Sep 15");
		expect(email.subject).not.toContain("Sep 16");
	});

	it("CONTROL: with no zone, the UTC server names the next day", () => {
		pinIntlTo("en-US", "UTC");
		expect(buildNotificationEmail(ROW).subject).toContain("Wed, Sep 16");
	});
});
