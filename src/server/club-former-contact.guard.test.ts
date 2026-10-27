import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

// `getMemberProfile` is a `createServerFn`, which no test can invoke (no
// session, no RPC layer), so its wiring has no behavioural surface here.
// `loadMemberProfile` withholds a FORMER member's contact unless the caller's
// `viewerMayRevealFormer` says yes (#1342), and the integration test
// (`former-member-contact.integration.test.ts`) proves that for every viewer.
// What it cannot prove is that the handler passes the right answer: a handler
// that passed `() => true`, or dropped the option, would leave every integration
// test green. Two properties are pinned here by source:
//
// 1. The viewer function asks `mayRevealFormerMembers` about the `access` the
//    handler's own `requireClubViewAccess` returned, the same rule that decides a
//    former member's Pathways. Not a role check of the handler's own: a plain
//    `clubRole === "admin"` would miss an elected officer and would serve "View
//    as this club", which `mayRevealFormerMembers` refuses.
// 2. `access` is the value `requireClubViewAccess` returned, not a stale or
//    different binding.
//
// Read comment-blind (`readSource`): these are "this text must BE present"
// assertions, which a comment merely naming the call would satisfy.
const source = readSource(resolve(__dirname, "club.ts"));

describe("getMemberProfile hands a former member's contact to an admin only (#1342)", () => {
	const body = serverFnBody(source, "getMemberProfile");

	it("keeps the grant requireClubViewAccess returned", () => {
		expect(body).toMatch(
			/const access = await requireClubViewAccess\(\s*currentUser\.id,\s*data\.clubId\s*\)/,
		);
	});

	it("passes the loader a viewer check that is mayRevealFormerMembers(access)", () => {
		expect(body).toMatch(
			/loadMemberProfile\(\s*data\.clubId,\s*data\.memberId,\s*\{\s*viewerMayRevealFormer:\s*\(\)\s*=>\s*mayRevealFormerMembers\(access\)/,
		);
	});
});
