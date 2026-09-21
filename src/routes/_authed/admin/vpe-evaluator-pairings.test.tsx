// @vitest-environment jsdom
//
// Component tests for the "Evaluator pairings" section of vpe-dashboard.tsx
// (#709). The rest of the route is unchanged; these cover only what the new
// section adds.
//
// Two things here are invisible to the server suite and are why this file
// exists. The repeat STATEMENT is text, not colour: `loadEvaluatorPairings`
// computes `hasRepeat` and an integration test can prove the flag, but nothing
// there can see whether the page says anything an officer (or a screen reader)
// can act on — a row whose only signal is an amber swatch passes every server
// assertion. And the stat tile counts REPEAT rows out of a list that holds
// every speaker with any history, so a dropped filter would put the club's
// whole speaking roster behind a "repeat evaluators" number with the server
// suite entirely green — the same shape as #530's `isLapsed` filter.
//
// Pattern follows vpe-upcoming-claim.test.tsx: mock the server-fn module (it
// reaches `#/db` → `pg`, which must not load under jsdom), stub
// `Route.useLoaderData`, and render the component directly.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	EvaluationPair,
	EvaluatorPairingRow,
} from "#/lib/evaluator-pairing";

vi.mock("#/server/reporting", () => ({
	getSpeakerRotation: vi.fn(),
	getOverdueMembers: vi.fn(),
	getAttendanceLapse: vi.fn(),
	getEvaluatorPairings: vi.fn(),
}));

import { Route } from "./vpe-dashboard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function evaluation(over: Partial<EvaluationPair> = {}): EvaluationPair {
	return {
		evaluatorKey: "eval-1",
		evaluatorName: "Sam Chen",
		isGuest: false,
		meetingId: "meeting-1",
		scheduledAt: new Date("2026-08-10T18:00:00Z"),
		repeat: false,
		...over,
	};
}

function pairingRow(
	over: Partial<EvaluatorPairingRow> = {},
): EvaluatorPairingRow {
	const recent = over.recent ?? [evaluation()];
	return {
		memberId: "speaker-1",
		name: "Alex Rivera",
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		distinctEvaluators: new Set(recent.map((p) => p.evaluatorKey)).size,
		hasRepeat: recent.some((p) => p.repeat),
		...over,
		recent,
	};
}

async function renderRoute(pairings: EvaluatorPairingRow[]) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: [],
		overdue: [],
		lapse: [],
		pairings,
		clubName: "Harbor City Speakers",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);

	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

/** The "Repeat evaluators" stat tile's number. */
function repeatStat() {
	const label = screen.getByText("Repeat evaluators", { selector: "div" });
	return label.parentElement?.querySelector("span")?.textContent;
}

describe("VPE dashboard — Evaluator pairings (#709)", () => {
	it("shows the empty state when nothing has been evaluated", async () => {
		await renderRoute([]);
		expect(screen.getByText("No evaluations recorded yet.")).toBeTruthy();
		expect(repeatStat()).toBe("0");
	});

	it("names each evaluator and when they evaluated", async () => {
		await renderRoute([
			pairingRow({
				recent: [
					evaluation({
						evaluatorKey: "a",
						evaluatorName: "Sam Chen",
						meetingId: "m1",
						scheduledAt: new Date("2026-08-10T18:00:00Z"),
					}),
					evaluation({
						evaluatorKey: "b",
						evaluatorName: "Dana Lee",
						meetingId: "m2",
						scheduledAt: new Date("2026-06-12T18:00:00Z"),
					}),
				],
			}),
		]);

		expect(screen.getByText("Alex Rivera")).toBeTruthy();
		expect(screen.getByText("Sam Chen")).toBeTruthy();
		expect(screen.getByText("Dana Lee")).toBeTruthy();
		// The date is what tells an assigner whether a pairing is stale; a chip
		// naming only the evaluator cannot answer "how recently".
		expect(screen.getByText("Aug 10")).toBeTruthy();
		expect(screen.getByText("Jun 12")).toBeTruthy();
	});

	it("marks a guest evaluator as a guest, in words", async () => {
		// #709's acceptance criterion: an evaluator who is not on the roster is
		// exactly the pairing an assigner would not otherwise count, and a chip
		// that reads like every other one hides that.
		await renderRoute([
			pairingRow({
				recent: [
					evaluation({
						evaluatorKey: "g1",
						evaluatorName: "Robin Visitor",
						isGuest: true,
					}),
				],
			}),
		]);
		expect(screen.getByText("Robin Visitor (guest)")).toBeTruthy();
	});

	it("states a repeat in TEXT, not only in colour", async () => {
		// The row's only actionable signal. Amber chips say nothing to a screen
		// reader, and little to a reader who cannot separate the two swatches.
		await renderRoute([
			pairingRow({
				recent: [
					evaluation({ evaluatorKey: "a", meetingId: "m1", repeat: true }),
					evaluation({ evaluatorKey: "a", meetingId: "m2", repeat: true }),
				],
			}),
		]);
		expect(
			screen.getByText("Repeated evaluator — vary the next one"),
		).toBeTruthy();
		expect(repeatStat()).toBe("1");
	});

	it("counts the distinct evaluators when there is no repeat", async () => {
		await renderRoute([
			pairingRow({
				recent: [
					evaluation({ evaluatorKey: "a", evaluatorName: "Sam Chen" }),
					evaluation({
						evaluatorKey: "b",
						evaluatorName: "Dana Lee",
						meetingId: "m2",
					}),
					evaluation({
						evaluatorKey: "c",
						evaluatorName: "Cleo Park",
						meetingId: "m3",
					}),
				],
			}),
		]);
		expect(screen.getByText("3 different evaluators")).toBeTruthy();
		expect(screen.queryByText(/Repeated evaluator/)).toBeNull();
		expect(repeatStat()).toBe("0");
	});

	it("says 'evaluator', singular, for one", async () => {
		await renderRoute([pairingRow()]);
		expect(screen.getByText("1 different evaluator")).toBeTruthy();
	});

	it("counts only the REPEAT rows in the stat, and still lists the rest", async () => {
		// The list holds every speaker with any history; the tile is about the
		// subset that needs action. A dropped filter would put the whole speaking
		// roster behind that number.
		await renderRoute([
			pairingRow({
				memberId: "a",
				name: "Repeat Speaker",
				recent: [
					evaluation({ evaluatorKey: "x", meetingId: "m1", repeat: true }),
					evaluation({ evaluatorKey: "x", meetingId: "m2", repeat: true }),
				],
			}),
			pairingRow({
				memberId: "b",
				name: "Varied Speaker",
				recent: [
					evaluation({ evaluatorKey: "y", meetingId: "m3" }),
					evaluation({ evaluatorKey: "z", meetingId: "m4" }),
				],
			}),
		]);

		expect(repeatStat()).toBe("1");
		// Both rows are still on the page — this section is a lookup, not an
		// alert list, so filtering it to the repeats would remove the answer to
		// "who last evaluated this speaker" for everybody else.
		expect(screen.getByText("Repeat Speaker")).toBeTruthy();
		expect(screen.getByText("Varied Speaker")).toBeTruthy();
	});

	it("links each speaker to their profile", async () => {
		await renderRoute([pairingRow({ memberId: "abc", name: "Alex Rivera" })]);
		const link = screen.getByText("Alex Rivera").closest("a");
		expect(link?.getAttribute("href")).toBe("/members/abc");
	});

	it("tells the officer how deep the history goes", async () => {
		// The subtitle names the window, so an officer reading two evaluators
		// knows whether that is the whole story or the last five.
		await renderRoute([pairingRow()]);
		expect(
			screen.getByText(/the last 5 evaluations of each speaker/),
		).toBeTruthy();
	});
});
