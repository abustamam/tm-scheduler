// @vitest-environment jsdom
//
// The Area Director notice on club settings (#1118): both wordings, that every
// number in `AREA_HEALTH_FIELDS` is named, and that a club in no area sees
// nothing. The component takes only a type from the server module, so nothing
// here is mocked.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AREA_HEALTH_FIELDS } from "#/lib/area-health-fields";
import { AreaNotice } from "./area-notice";

afterEach(cleanup);

const NOTICE = {
	areaLabel: "C3",
	divisionLetter: "C",
	districtNumber: "39",
	directorName: "Jamie Rivera",
};

const NUMBERS = AREA_HEALTH_FIELDS.map((f) => f.label).join(", ");
const NOTHING_ELSE =
	"Being Area Director gives them nothing else: no member names and no contact details.";

/** The notice's text with runs of whitespace collapsed, as a reader sees it. */
function noticeText() {
	return (screen.getByTestId("area-notice").textContent ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

describe("AreaNotice", () => {
	it("names the area, the director and the numbers, and says the role gives nothing else", () => {
		render(<AreaNotice notice={NOTICE} />);
		expect(noticeText()).toBe(
			`Area C3 · Division C · District 39. As your Area Director, Jamie Rivera can see these numbers for your club: ${NUMBERS}. ${NOTHING_ELSE}`,
		);
	});

	it("says no Area Director is assigned yet, still listing the numbers, when none is current", () => {
		render(<AreaNotice notice={{ ...NOTICE, directorName: null }} />);
		expect(noticeText()).toBe(
			`Area C3 · Division C · District 39. No Area Director is assigned yet. When one is, they'll see these numbers for your club: ${NUMBERS}. ${NOTHING_ELSE}`,
		);
		expect(noticeText()).not.toContain("As your Area Director");
	});

	it("names every field in AREA_HEALTH_FIELDS, in order, whichever wording shows", () => {
		// Fails if the component drops, reorders or retypes a label: it compares
		// what is on the page with the list the Area Director's view is built from.
		for (const directorName of ["Jamie Rivera", null]) {
			render(<AreaNotice notice={{ ...NOTICE, directorName }} />);
			const shown = Array.from(
				screen.getByTestId("area-notice").querySelectorAll("[data-field]"),
			).map((el) => [
				el.getAttribute("data-field"),
				el.textContent?.replace(/^, /, ""),
			]);
			expect(shown).toEqual(AREA_HEALTH_FIELDS.map((f) => [f.key, f.label]));
			cleanup();
		}
	});

	it("renders nothing for a club in no area", () => {
		const { container } = render(<AreaNotice notice={null} />);
		expect(container.innerHTML).toBe("");
		expect(screen.queryByTestId("area-notice")).toBeNull();
	});
});
