/**
 * `resolveMeetingKeyForUser` resolves through the ARCHIVE-GATED seam (#877).
 *
 * Nothing else would notice if it did not. `resolveMeetingKey` and
 * `resolvePublicMeetingKey` share a signature, so swapping one for the other
 * type-checks; the archive sweep in `public-readers-archive-gate.guard.test.ts`
 * skips any fn that calls `requireUser` (a session is its exemption, not an
 * archive check); and the agenda route's tests mock this module wholesale. So
 * without this file an archived club's editor would resolve a key to its uuid
 * again, and every gate would stay green.
 *
 * Two separate cases, not two expects in one `it`, for the reason that file
 * gives: a shared `it` makes the second assertion unreachable when the first
 * fails, so a mutation aimed at one would demonstrate the other twice.
 *
 * The positive case reads comment-blind (a comment naming the seam is not a
 * call); the negative reads raw, because stripping could only hide an offender.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const FILE = resolve(__dirname, "meeting-key.ts");
const FN = "resolveMeetingKeyForUser";

describe(`${FN} is archive-gated`, () => {
	it("resolves through resolvePublicMeetingKey", () => {
		expect(serverFnBody(readSource(FILE), FN)).toMatch(
			/resolvePublicMeetingKey\(/,
		);
	});

	it("never calls the ungated resolveMeetingKey", () => {
		expect(
			serverFnBody(readFileSync(FILE, "utf8"), FN),
			"resolveMeetingKey carries no archive check; an archived club would resolve again",
		).not.toMatch(/\bresolveMeetingKey\(/);
	});
});
