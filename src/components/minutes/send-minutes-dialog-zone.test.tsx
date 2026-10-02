// @vitest-environment jsdom
//
// #1017: the minutes draft's default subject and body name the meeting's day.
// The dialog runs in the OFFICER's browser, so with no zone the day was the
// officer's: a Los Angeles meeting at 7pm on Sep 30 (02:00 UTC on Oct 1),
// drafted from Tokyo, became "Minutes for Thu, Oct 1". It now names the day in
// the club's zone, which the meeting page passes down.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildMinutesBody,
	buildMinutesSubject,
} from "#/server/minutes-email-logic";
import { pinIntlTo, restoreIntl } from "#/test/hydration-across-runtimes";
import { SendMinutesDialog } from "./send-minutes-dialog";

afterEach(() => {
	cleanup();
	restoreIntl();
});

/** 7pm on Wed Sep 30 in Los Angeles; already Oct 1 in UTC and in Tokyo. */
const MEETING = new Date("2026-10-01T02:00:00Z");
const CLUB_ZONE = "America/Los_Angeles";
const TOKYO = () => pinIntlTo("ja-JP", "Asia/Tokyo");

describe("the minutes draft names the club's day (#1017)", () => {
	it("from Tokyo, an LA meeting is Sep 30 in the subject and the body", () => {
		TOKYO();
		expect(buildMinutesSubject("Acme TM", MEETING, CLUB_ZONE)).toBe(
			"Acme TM — Minutes for Wed, Sep 30",
		);
		const body = buildMinutesBody("Acme TM", MEETING, CLUB_ZONE);
		expect(body).toContain("meeting on Wed, Sep 30.");
		expect(body).not.toContain("Oct 1");
	});

	it("the dialog passes the club's zone to both builders", async () => {
		TOKYO();
		render(
			<SendMinutesDialog
				meetingId="22222222-2222-4222-8222-222222222222"
				clubName="Acme TM"
				meetingDate={MEETING.toISOString()}
				timezone={CLUB_ZONE}
				initialRecipients={[{ name: "Ada", email: "ada@club.org" }]}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /email the minutes/i }),
		);
		expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
			"Acme TM — Minutes for Wed, Sep 30",
		);
		const body = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
		expect(body.value).toContain("meeting on Wed, Sep 30.");
	});

	it("CONTROL: in the officer's zone, the same meeting is Oct 1", () => {
		TOKYO();
		expect(buildMinutesSubject("Acme TM", MEETING, "Asia/Tokyo")).toContain(
			"Thu, Oct 1",
		);
	});
});
