/**
 * The layout list is stated ONCE (#1069), in `src/lib/agenda-layouts.ts`.
 *
 * Three surfaces are built from it and must stay exactly it, in its order: the
 * pg enum behind `clubs.default_print_layout`, the zod enum the Agenda card's
 * save is parsed with, and the print route's tabs. Before #1069 the ids were
 * written out by hand in two places and the default in two more; a fifth
 * layout added to one list and not another is a tab that cannot be made the
 * default, or a default the print page has no tab for.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));

const { AGENDA_LAYOUTS } = await import("./agenda-layouts");
const { agendaPrintLayoutEnum, clubs } = await import("#/db/schema");
const { clubAgendaSettingsSchema } = await import("#/server/clubs-logic");
const { LAYOUTS } = await import(
	"#/routes/club.$clubId_.meeting.$meetingId.print"
);

describe("one list of agenda layouts (#1069)", () => {
	it("the pg enum is exactly AGENDA_LAYOUTS", () => {
		expect(agendaPrintLayoutEnum.enumName).toBe("agenda_print_layout");
		expect([...agendaPrintLayoutEnum.enumValues]).toEqual([...AGENDA_LAYOUTS]);
		// And it is the enum the column actually uses.
		expect(clubs.defaultPrintLayout.enumValues).toEqual([...AGENDA_LAYOUTS]);
	});

	it("the settings schema's zod enum is exactly AGENDA_LAYOUTS", () => {
		const field = clubAgendaSettingsSchema.shape.defaultPrintLayout;
		expect(field.unwrap().options).toEqual([...AGENDA_LAYOUTS]);
	});

	it("the print route's tabs are exactly AGENDA_LAYOUTS, in order", () => {
		expect(LAYOUTS.map((l) => l.id)).toEqual([...AGENDA_LAYOUTS]);
	});
});
