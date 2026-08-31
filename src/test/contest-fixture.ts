// src/test/contest-fixture.ts
//
// MCF's club contest, 2026-09-10 — the seeded `speech_contest` shape at four
// contestants, as one fixture.
//
// Shared by `agenda-budget.test.ts` and `agenda-editor-parity.test.ts` so the
// golden numbers (92 minutes, ends 8:17, 21 rows) and the editor/print parity
// assertion cannot drift apart. A parity test compares two derivations; if each
// side built its own fixture, the two could agree perfectly about a shape
// neither club runs.
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-rows";

function beat(
	over: Partial<TemplateBeatRow> & {
		id: string;
		sortOrder: number;
		label: string;
	},
): TemplateBeatRow {
	return {
		kind: "event",
		detail: null,
		minutes: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		...over,
	};
}

const ROLES: TemplateRoleRow[] = [
	{ key: "sergeant_at_arms", name: "Sergeant at Arms", isSpeakerRole: false },
	{ key: "contest_chair", name: "Contest Chair", isSpeakerRole: false },
	{ key: "chief_judge", name: "Chief Judge", isSpeakerRole: false },
	{ key: "ballot_counter", name: "Ballot Counter", isSpeakerRole: false },
	{ key: "contest_timer", name: "Contest Timer", isSpeakerRole: false },
	// The template's ONLY speaker role — see `contest-template.ts`.
	{ key: "contestant_prepared", name: "Contestant", isSpeakerRole: true },
];

const NAMES = ["Faisal Ali", "Rehanna Khan", "Jagpal Singh", "Riyaz Mohammed"];

export function contestFixture(contestants = 4) {
	const beats: TemplateBeatRow[] = [
		beat({ id: "s1", sortOrder: 0, kind: "section", label: "OPENING" }),
		beat({
			id: "o1",
			sortOrder: 1,
			kind: "role",
			label: "Call to order",
			roleKey: "sergeant_at_arms",
			minutes: 5,
		}),
		beat({
			id: "o2",
			sortOrder: 2,
			kind: "role",
			label: "Welcome and introductions",
			roleKey: "contest_chair",
			minutes: 5,
		}),
		beat({
			id: "o3",
			sortOrder: 3,
			kind: "role",
			label: "Judges' briefing",
			roleKey: "chief_judge",
			minutes: 10,
		}),
		beat({
			id: "o4",
			sortOrder: 4,
			kind: "role",
			label: "Contest rules and timing",
			roleKey: "contest_chair",
			minutes: 5,
		}),
		beat({ id: "s2", sortOrder: 5, kind: "section", label: "SPEECHES" }),
		beat({
			id: "sp",
			sortOrder: 6,
			kind: "role",
			label: "Contest speech",
			roleKey: "contestant_prepared",
			repeatsRoleKey: "contestant_prepared",
			minutes: 7,
			markGreen: 5,
			markYellow: 6,
			markRed: 7,
		}),
		beat({
			id: "si",
			sortOrder: 7,
			label: "One minute of silence",
			repeatsRoleKey: "contestant_prepared",
			minutes: 1,
		}),
		beat({
			id: "t1",
			sortOrder: 8,
			label: "Two minutes of silence",
			minutes: 2,
		}),
		beat({
			id: "t2",
			sortOrder: 9,
			kind: "role",
			label: "Contestant interviews",
			roleKey: "contest_chair",
			minutes: 5,
		}),
		beat({
			id: "s3",
			sortOrder: 10,
			kind: "section",
			label: "RESULTS AND CLOSING",
		}),
		beat({
			id: "r1",
			sortOrder: 11,
			kind: "role",
			label: "Tallying",
			roleKey: "ballot_counter",
			minutes: 10,
		}),
		beat({
			id: "r2",
			sortOrder: 12,
			kind: "role",
			label: "Timers' report",
			roleKey: "contest_timer",
			minutes: 3,
		}),
		beat({
			id: "r3",
			sortOrder: 13,
			kind: "role",
			label: "Results and certificates",
			roleKey: "contest_chair",
			minutes: 10,
		}),
		beat({
			id: "r4",
			sortOrder: 14,
			kind: "role",
			label: "Closing remarks",
			roleKey: "contest_chair",
			minutes: 5,
		}),
	];

	const slots: AgendaSlot[] = [];
	for (const role of ROLES) {
		const count = role.isSpeakerRole ? contestants : 1;
		for (let i = 0; i < count; i += 1) {
			slots.push({
				id: `${role.key}-${i}`,
				roleName: role.name,
				roleKey: role.key,
				category: role.isSpeakerRole ? "speaker" : "leadership",
				isSpeakerRole: role.isSpeakerRole,
				slotIndex: i,
				assigneeName: role.isSpeakerRole
					? (NAMES[i] ?? `Contestant ${i + 1}`)
					: role.name,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			});
		}
	}

	return {
		beats,
		roles: ROLES,
		slots,
		/** 6:45 PM America/Chicago on 2026-09-10. */
		startsAt: new Date("2026-09-10T23:45:00.000Z"),
		tz: "America/Chicago",
		length: 90,
	};
}
