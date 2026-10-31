/**
 * No server fn hands the stored video-call link to a self-asserted caller
 * (#1444, D6, option A).
 *
 * `requireMeetingAgendaEditor` accepts a `selfMemberId` the caller asserts, and
 * the TMOD's member id is public, so a reader behind that gate would give the
 * link to anyone signed out. The Edit meeting dialog instead leaves the stored
 * link alone when the payload withholds it and the field is untouched.
 *
 * Covers: the reader is gone from `meetings.ts`, and the meeting route never
 * fetches the link. Does NOT cover: the payload readers (`meeting-join-url.guard.test.ts`).
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SERVER = readSource(resolve(__dirname, "meetings.ts"));
const ROUTE = readSource(
	resolve(__dirname, "../routes/club.$clubId.meeting.$meetingId.tsx"),
);

describe("no link reader behind a self-asserted gate", () => {
	// protects=the link never leaves through an `selfMemberId`-gated GET
	// fails_when=a server fn selecting `meetings.joinUrl` reappears in meetings.ts
	//   outside the member-gated payload readers
	it("has no getMeetingJoinUrlForEditor, and selects joinUrl nowhere else for an editor", () => {
		expect(SERVER).not.toContain("getMeetingJoinUrlForEditor");
		expect(SERVER).not.toMatch(/select\(\{\s*link:\s*meetings\.joinUrl/);
	});

	// protects=the route never asks for the link on behalf of a non-member
	// fails_when=the route imports or calls a link reader again
	it("never fetches the link in the meeting route", () => {
		expect(ROUTE).not.toMatch(/JoinUrlFor|editorJoinUrl|meeting-join-url/);
	});
});
