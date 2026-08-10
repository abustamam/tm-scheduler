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

// #541 moved the share chip OUT of the route and into `MeetingToolbar`, which
// stranded this guard: it kept reading the route, where the chip no longer is,
// and passed vacuously. The plan even cited it staying green as evidence the
// single label survived — it stayed green because its subject had left the
// file. Both files are read now, so re-introducing the override in EITHER place
// turns it red (red-team review).
const SUBJECTS = [
	resolve(ROUTES, "club.$clubId.meeting.$meetingId.tsx"),
	resolve(ROUTES, "../components/club/meeting-toolbar.tsx"),
];

describe("meeting share chip label (#542)", () => {
	it.each(
		SUBJECTS,
	)("has no audience-dependent 'Copy member link' override in %s", (subject) => {
		expect(readSource(subject)).not.toContain("Copy member link");
	});

	// Vacuity check: an "offenders must be absent" guard passes just as happily
	// when its subject stops rendering the thing at all — which is exactly how
	// this guard died the first time. Pin that the chip is still HERE, so the
	// next move strands it loudly instead of silently.
	it("the share chip still renders where this guard is looking", () => {
		const rendered = SUBJECTS.filter((s) =>
			readSource(s).includes("<ShareLinkButton"),
		);
		expect(
			rendered.length,
			"no file this guard reads renders <ShareLinkButton> any more — the chip " +
				"moved again and this guard is protecting nothing. Point it at the " +
				"new home rather than deleting it.",
		).toBeGreaterThanOrEqual(1);
	});
});
