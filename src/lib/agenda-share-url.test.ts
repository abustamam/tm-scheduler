import { describe, expect, it } from "vitest";
import { buildAgendaSharePath } from "./agenda-share-url";

describe("buildAgendaSharePath", () => {
	it("locks the layout and hides the chrome", () => {
		expect(buildAgendaSharePath("downtown", "2026-07-22", "editorial")).toBe(
			"/club/downtown/meeting/2026-07-22/print?layout=editorial&chrome=none",
		);
	});

	it("passes a date+HHmm collision key straight through", () => {
		expect(buildAgendaSharePath("downtown", "2026-07-22-1830", "grid")).toBe(
			"/club/downtown/meeting/2026-07-22-1830/print?layout=grid&chrome=none",
		);
	});

	it("still works with a raw uuid meeting key", () => {
		const uuid = "11111111-1111-4111-8111-111111111111";
		expect(buildAgendaSharePath("downtown", uuid, "timing")).toBe(
			`/club/downtown/meeting/${uuid}/print?layout=timing&chrome=none`,
		);
	});
});
