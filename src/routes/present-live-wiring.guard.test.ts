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

/** The text of the balanced parenthesised call whose "(" is at `open`. */
function callBody(src: string, open: number): string {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "(") depth++;
		else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
	}
	return src.slice(open);
}

// protects=the Present deck is built from live data, not loader data;
// fails_when=either deck builder is fed `loaded.` again (checked per call,
// across nested braces); no_claim=nothing about the re-read or the render.
describe("present route -> live meeting wiring", () => {
	const src = readSource(PRESENT);

	it("reads the loader into useLiveMeeting and builds from its result", () => {
		expect(src).toMatch(/const loaded = Route\.useLoaderData\(\)/);
		expect(src).toMatch(/const data = useLiveMeeting\(\s*loaded,/);
		for (const builder of ["buildSlideDeck", "buildTemplateSlideDeck"]) {
			const at = src.indexOf(`${builder}(`);
			expect(at, `${builder} is called`).toBeGreaterThan(-1);
			expect(
				callBody(src, at + builder.length),
				`${builder} must be fed the live \`data\`, never \`loaded\``,
			).not.toMatch(/\bloaded\b/);
		}
	});

	it("re-reads through the same public projection as the loader", () => {
		expect(src).toMatch(/inRoomMeetingPayload\(fresh\)/);
	});
});
