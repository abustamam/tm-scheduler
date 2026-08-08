// #542: the meeting view's share chip is ONE label for every audience. It
// used to render "Copy member link" for officers and "Copy share link" for
// everyone else — same copied URL, two names for it. The override was removed
// so `ShareLinkButton`'s default label is the single source.
//
// A source guard rather than a render test because the override lived in the
// ROUTE component (`club.$clubId.meeting.$meetingId.tsx`), which mounts a
// loader + server fns and cannot render standalone in jsdom. Comment-blind
// (`readSource`): the route file's comment explaining the change names the old
// label, so a raw grep would falsely fail on the explanation itself.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));

describe("meeting share chip label (#542)", () => {
	it("has no audience-dependent 'Copy member link' override left in the meeting route", () => {
		const src = readSource(
			resolve(ROUTES, "club.$clubId.meeting.$meetingId.tsx"),
		);
		expect(src).not.toContain("Copy member link");
	});
});
