/**
 * The two enums convert's privilege handling INFERS from rather than reads
 * (#501 review).
 *
 * `applyConvertGuestToMember` records `reactivatedFrom: "inactive"` after a
 * wake-up without ever reading the old value — Postgres `RETURNING` hands back
 * post-update rows, and the pre-update `status` it does read is only compared
 * against `"active"`. The recorded value is therefore correct because
 * `membership_status` has exactly two members and `active` is the other one.
 * Same shape one column over: the demotion writes `club_role: "member"` and
 * records `demotedFrom: "admin"` because those are the only two roles there
 * are.
 *
 * Both inferences are invisible at the call site and both are silently wrong
 * the moment somebody adds a third value — a membership that lapsed as
 * `suspended` would be recorded as having lapsed as `inactive`, and undo would
 * put back a status it never had. A `pending` club role would be demoted to
 * `member` and recorded as having been `admin`. Nothing would throw; the
 * activity log would simply start lying, and the undo built on it with it.
 *
 * So the widening fails HERE, at the comment forbidding it, rather than in
 * production six months later. That is the whole job of this file: it is a pin,
 * not a test of behaviour. If you are here because it failed, the fix is to go
 * read `applyConvertGuestToMember`'s reuse branch and `readConversionRecord`
 * and decide what the new value means on each of them — then update this file
 * LAST.
 *
 * Pure: `#/db/schema` is table and enum declarations only, so this needs no
 * database and runs in every `bun run test`, including the ones with no
 * `TEST_DATABASE_URL` where the integration suites skip.
 */
import { describe, expect, it } from "vitest";
import { clubRoleEnum, membershipStatusEnum } from "#/db/schema";

describe("enums convert's privilege handling infers from (#501)", () => {
	it("membership_status is exactly (active, inactive)", () => {
		// Exact and ordered, not `toContain`: the claim is that `inactive` is the
		// ONLY thing "not active" can mean, and a containment check would pass on
		// an enum that had grown a third member — which is the only failure this
		// file exists to catch.
		expect(membershipStatusEnum.enumValues).toEqual(["active", "inactive"]);
	});

	it("club_role is exactly (admin, member)", () => {
		// `member` is the floor the demotion writes to and `admin` is the sole
		// value it can have written down FROM. A third role would make
		// `demotedFrom: "admin"` a fabrication and `clubRole: "member"` a
		// silent, unrecorded change of a different permission.
		expect(clubRoleEnum.enumValues).toEqual(["admin", "member"]);
	});
});
