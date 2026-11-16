/**
 * The Present route builds its deck from `useLiveMeeting`, not the raw loader
 * data (#1637). Both deck builders are well tested with whatever inputs they
 * are given; what nothing else sees is the route reading `Route.useLoaderData()`
 * straight into them, which typechecks and renders, and silently freezes the
 * deck at page load.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const PRESENT = "src/routes/club.$clubId_.meeting.$meetingId.present.tsx";

describe("present route -> live meeting wiring", () => {
	const src = readSource(PRESENT);

	it("reads the loader into useLiveMeeting and builds from its result", () => {
		expect(src).toMatch(/const loaded = Route\.useLoaderData\(\)/);
		expect(src).toMatch(/const data = useLiveMeeting\(\s*loaded,/);
		expect(
			src,
			"the deck must be built from the live `data`, never from `loaded`",
		).not.toMatch(/buildSlideDeck\(\{[^}]*loaded\./);
		expect(src).toMatch(/buildSlideDeck\(/);
		expect(src).toMatch(/buildTemplateSlideDeck\(/);
	});

	it("re-reads through the same public projection as the loader", () => {
		expect(src).toMatch(/inRoomMeetingPayload\(fresh\)/);
	});
});
