// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
	MeetingReadiness,
	ReadinessGap,
	ReadinessItem,
} from "#/lib/meeting-readiness";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingReadinessPanel } from "./meeting-readiness-panel";

afterEach(cleanup);

const gap = (n: number, holderName: string | null = null): ReadinessGap => ({
	slotId: `s${n}`,
	slotLabel: `Role ${n}`,
	holderName,
});

function item(
	over: Partial<ReadinessItem> & Pick<ReadinessItem, "id" | "label">,
): ReadinessItem {
	const gaps = over.gaps ?? [];
	const total = over.total ?? 4;
	return {
		done: gaps.length === 0,
		doneCount: total - gaps.length,
		total,
		gaps,
		...over,
	};
}

async function renderPanel(readiness: MeetingReadiness) {
	await renderUnderMemoryRouter(
		<MeetingReadinessPanel
			readiness={readiness}
			clubId="downtown"
			meetingId="2026-10-10"
		/>,
	);
}

describe("MeetingReadinessPanel (#963)", () => {
	it("not ready: a card titled 'Before the meeting' with one row per item and its counts", async () => {
		await renderPanel({
			ready: false,
			items: [
				item({
					id: "roles_filled",
					label: "Roles filled",
					total: 5,
					gaps: [
						{ slotId: "a", slotLabel: "Ah-Counter", holderName: null },
						{ slotId: "b", slotLabel: "Speaker 2", holderName: "Pat" },
					],
				}),
				item({ id: "meeting_theme", label: "Theme set", total: 1 }),
			],
		});
		expect(
			screen.getByRole("heading", { name: "Before the meeting" }),
		).toBeTruthy();
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("Roles filled");
		expect(rows[0]?.textContent).toContain("3/5");
		// An open slot reads "(open)"; a held one names its holder.
		expect(rows[0]?.textContent).toContain("Ah-Counter (open)");
		expect(rows[0]?.textContent).toContain("Speaker 2 (Pat)");
		expect(rows[0]?.getAttribute("data-done")).toBe("false");
		// A done row carries no gap line and is announced as done.
		expect(rows[1]?.textContent).toContain("Theme set");
		expect(rows[1]?.textContent).toContain("1/1");
		expect(rows[1]?.getAttribute("data-done")).toBe("true");
		expect(within(rows[1] as HTMLElement).queryByText(/\(open\)/)).toBeNull();
		// The page says "Everything's set" ONLY when it is.
		expect(screen.queryByText(/Everything's set/)).toBeNull();
	});

	it("names three gaps at most, then '+N more'; three exactly says no more", async () => {
		await renderPanel({
			ready: false,
			items: [
				item({
					id: "roles_filled",
					label: "Roles filled",
					total: 8,
					gaps: [1, 2, 3, 4, 5].map((n) => gap(n, `Holder ${n}`)),
				}),
				item({
					id: "roles_confirmed",
					label: "Roles confirmed",
					total: 8,
					gaps: [1, 2, 3].map((n) => gap(n, `Holder ${n}`)),
				}),
			],
		});
		const [filled, confirmed] = screen.getAllByRole("listitem");
		const filledText = filled?.textContent ?? "";
		expect(filledText).toContain("Role 1 (Holder 1)");
		expect(filledText).toContain("Role 3 (Holder 3)");
		expect(filledText).not.toContain("Role 4");
		expect(filledText).not.toContain("Role 5");
		expect(filledText).toContain("+2 more");
		const confirmedText = confirmed?.textContent ?? "";
		expect(confirmedText).toContain("Role 3 (Holder 3)");
		expect(confirmedText).not.toContain("more");
	});

	it("ready: no item rows, just the one line and the deck link", async () => {
		await renderPanel({
			ready: true,
			items: [
				item({ id: "roles_filled", label: "Roles filled" }),
				item({ id: "meeting_theme", label: "Theme set", total: 1 }),
			],
		});
		expect(screen.getByText("Everything's set for this meeting")).toBeTruthy();
		expect(screen.queryAllByRole("listitem")).toHaveLength(0);
		expect(screen.queryByText("Roles filled")).toBeNull();
		expect(screen.queryByRole("heading")).toBeNull();
		expect(screen.getByRole("link", { name: "Preview the deck" })).toBeTruthy();
	});

	it("links to the deck on the present route, in a new tab, in both states", async () => {
		for (const ready of [false, true]) {
			await renderPanel({
				ready,
				items: ready
					? []
					: [
							item({
								id: "roles_filled",
								label: "Roles filled",
								gaps: [gap(1)],
							}),
						],
			});
			const link = screen.getByRole("link", { name: "Preview the deck" });
			expect(link.getAttribute("href")).toBe(
				"/club/downtown/meeting/2026-10-10/present",
			);
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toContain("noopener");
			cleanup();
		}
	});

	it("is read-only: the deck link is the only interactive control", async () => {
		await renderPanel({
			ready: false,
			items: [
				item({
					id: "roles_confirmed",
					label: "Roles confirmed",
					gaps: [gap(1, "Pat")],
				}),
			],
		});
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(screen.getAllByRole("link")).toHaveLength(1);
	});
});
