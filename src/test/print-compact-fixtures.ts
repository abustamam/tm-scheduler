/**
 * The agendas `print-compact.test.tsx` and its Chrome entry share (#1226), so the
 * test reads the same rows the browser rendered. No React and no DOM here: the
 * entry bundles this for the browser and the test imports it under jsdom.
 */
import type {
	AgendaHeader,
	AgendaOfficer,
	AgendaRoleEntry,
} from "#/components/agenda/meeting-agenda-print";
import { buildRosterEntries } from "#/lib/agenda";
import { applyFlex, resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildTimeline, type TimelineRow } from "#/lib/agenda-timing";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import {
	CONTEST_CONTESTANTS,
	contestFixture,
	contestRosterSlots,
} from "#/test/contest-fixture";
import {
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import { withBeatIds } from "#/test/template-beat-ids";
import { THR_OFFICERS, thrAgendaLong } from "#/test/thr-agenda-fixture";

export type PrintCompactAgenda = {
	header: AgendaHeader;
	roles: AgendaRoleEntry[];
	officers: AgendaOfficer[];
	rows: TimelineRow[];
};

export type PrintCompactFixtureId =
	| "mcf"
	| "thrLong"
	| "contest7"
	| `contestDense${number}`;

const SEVEN = [
	...CONTEST_CONTESTANTS,
	"Anshul Khindri",
	"Diego Nuci",
	"Muhammad Ali",
];

/** `n` contestant names for the roster, past the seven real ones. */
const contestants = (n: number) =>
	Array.from({ length: n }, (_, i) => SEVEN[i] ?? `Contestant Number ${i + 1}`);

/** `contest-fixture.ts` at seven contestants, rows as the print route builds
 *  them (`resolveAgendaRows`, `applyFlex`, `buildTimeline`). */
function contest7(): PrintCompactAgenda {
	const f = contestFixture(7);
	return {
		header: MCF_HEADER,
		roles: buildRosterEntries(contestRosterSlots(SEVEN)),
		officers: MCF_OFFICERS,
		rows: buildTimeline(
			applyFlex(
				resolveAgendaRows({
					geIntroducesFunctionaries: false,
					tableTopicsLimits: null,
					template: { beats: f.beats, roles: f.roles },
					slots: f.slots,
				}),
				f.length,
			).rows,
			f.startsAt,
			f.tz,
		),
	};
}

/** The seeded `speech_contest` template at `n` contestants with the long member
 *  names `print-density.test.tsx` measures its contest floor against: 58 rows at
 *  seven, where `contest7` above is 27. */
function contestDense(n: number): PrintCompactAgenda {
	const roleRows = CONTEST_TEMPLATE.roles.map((r) => ({
		key: r.key,
		name: r.name,
		isSpeakerRole: r.isSpeakerRole,
	}));
	const slots = CONTEST_TEMPLATE.roles.flatMap((r) => {
		const count = r.key.startsWith("contestant_") ? n : r.defaultCount;
		return Array.from({ length: count }, (_, i) => ({
			id: `${r.key}-${i}`,
			roleName: r.name,
			roleKey: r.key,
			category: r.category,
			isSpeakerRole: r.isSpeakerRole,
			slotIndex: i,
			assigneeName: `Anneliese Vandermeer-Castellanos ${i + 1}`,
			speechTitle: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			evaluatesSlotId: null,
			evaluates: null,
		}));
	});
	return {
		header: MCF_HEADER,
		roles: buildRosterEntries(contestRosterSlots(contestants(n))),
		officers: MCF_OFFICERS,
		rows: buildTimeline(
			resolveAgendaRows({
				geIntroducesFunctionaries: false,
				tableTopicsLimits: null,
				template: {
					beats: withBeatIds(CONTEST_TEMPLATE.beats),
					roles: roleRows,
				},
				slots,
			}),
			new Date("2026-09-12T13:00:00Z"),
			"America/Chicago",
		),
	};
}

export function printCompactAgenda(
	id: PrintCompactFixtureId,
): PrintCompactAgenda {
	switch (id) {
		case "mcf":
			return {
				header: MCF_HEADER,
				roles: MCF_ROLES,
				officers: MCF_OFFICERS,
				rows: MCF_ROWS,
			};
		case "thrLong": {
			const { header, roles, rows } = thrAgendaLong({
				veena: "Guest",
				david: "Guest",
			});
			return { header, roles, officers: THR_OFFICERS, rows };
		}
		case "contest7":
			return contest7();
		default:
			return contestDense(Number(id.slice("contestDense".length)));
	}
}
