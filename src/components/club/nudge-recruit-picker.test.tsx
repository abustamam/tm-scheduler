// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildRecruitTargets,
	NudgeRecruitPicker,
	type RecruitTarget,
} from "./nudge-recruit-picker";

// cmdk measures its list on mount and scrolls the active item into view;
// jsdom has neither API, so the picker cannot render without these.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver =
	ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

const roster = [
	{ id: "a", name: "Ada", phone: "1", email: null },
	{ id: "b", name: "Bo", phone: null, email: null },
	{ id: "c", name: "Cy", phone: null, email: "cy@x.io" },
];

describe("buildRecruitTargets", () => {
	it("includes every member — never filters (annotate, not filter)", () => {
		const t = buildRecruitTargets(roster, new Set(), {});
		expect(t.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("carries the effective preferred contact through (#1094)", () => {
		const t = buildRecruitTargets(
			[
				{
					...(roster[0] as (typeof roster)[0]),
					preferredContact: "sms" as const,
				},
				roster[1] as (typeof roster)[0],
			],
			new Set(),
			{},
		);
		expect(t.find((x) => x.id === "a")?.preferredContact).toBe("sms");
		expect(t.find((x) => x.id === "b")?.preferredContact).toBeNull();
	});

	it("flags members marked not available, leaves others unflagged", () => {
		const t = buildRecruitTargets(roster, new Set(["b"]), {});
		expect(t.find((x) => x.id === "b")?.notAvailable).toBe(true);
		expect(t.find((x) => x.id === "a")?.notAvailable).toBe(false);
	});

	it("flags the role a member already holds this meeting", () => {
		const t = buildRecruitTargets(roster, new Set(), { c: "Timer" });
		expect(t.find((x) => x.id === "c")?.alreadyRole).toBe("Timer");
		expect(t.find((x) => x.id === "a")?.alreadyRole).toBeNull();
	});

	it("carries the goes-by name through so the recruit draft greets correctly", () => {
		// The recruit draft reads this off the target (#486); a member without one
		// must come through as null so `greetingName` falls back, not `undefined`.
		const t = buildRecruitTargets(
			[
				{
					id: "d",
					name: "Abdul-Rasheed Bustamam",
					preferredName: "Rasheed",
					phone: "1",
					email: null,
				},
				...roster,
			],
			new Set(),
			{},
		);
		expect(t.find((x) => x.id === "d")?.preferredName).toBe("Rasheed");
		expect(t.find((x) => x.id === "a")?.preferredName).toBeNull();
	});

	it("carries contact through so the picker can show channels or no-contact", () => {
		const t = buildRecruitTargets(roster, new Set(), {});
		expect(t.find((x) => x.id === "b")).toMatchObject({
			phone: null,
			email: null,
		});
		expect(t.find((x) => x.id === "c")?.email).toBe("cy@x.io");
	});

	it("flags contacted members", () => {
		const targets = buildRecruitTargets(
			[
				{ id: "m1", name: "Alice" },
				{ id: "m2", name: "Bob" },
			],
			new Set<string>(), // unavailable
			{}, // roleByMemberId
			new Set(["m1"]), // contactedIds
		);
		expect(targets.find((t) => t.id === "m1")?.contacted).toBe(true);
		expect(targets.find((t) => t.id === "m2")?.contacted).toBe(false);
	});

	it("defaults contacted to false when no contactedIds passed", () => {
		const targets = buildRecruitTargets(
			[{ id: "m1", name: "Alice" }],
			new Set<string>(),
			{},
		);
		expect(targets[0]?.contacted).toBe(false);
	});
});

describe("NudgeRecruitPicker", () => {
	afterEach(() => cleanup());

	function target(over: Partial<RecruitTarget> = {}): RecruitTarget {
		return {
			id: "d",
			name: "Abdul-Rasheed Bustamam",
			preferredName: null,
			phone: "14155552671",
			email: "r@x.io",
			notAvailable: false,
			alreadyRole: null,
			contacted: false,
			...over,
		};
	}

	async function pick(t: RecruitTarget) {
		const user = userEvent.setup();
		render(
			<NudgeRecruitPicker
				roleName="Timer"
				meetingDate="Thu, Jul 23"
				shareUrl="https://gavelup.app/club/mcf/meeting/abc"
				targets={[t]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /nudge someone/i }));
		await user.click(await screen.findByText(t.name));
		return screen.findByRole("link", { name: /whatsapp/i });
	}

	function draftText(link: Element): string {
		const href = link.getAttribute("href") ?? "";
		return decodeURIComponent(new URL(href).searchParams.get("text") ?? "");
	}

	it("greets the picked member by their recorded goes-by name", async () => {
		// Guards `preferredName={livePicked.preferredName}` — the recruit half of
		// #486. Without it the draft opens "Hi Abdul-Rasheed," and every other
		// test in this file still passes.
		const wa = await pick(target({ preferredName: "Rasheed" }));
		expect(draftText(wa)).toContain("Hi Rasheed,");
		expect(draftText(wa)).not.toContain("Abdul-Rasheed");
	});

	it("falls back to the first name when none is recorded", async () => {
		const wa = await pick(target({ name: "Zabihullah Kogyani" }));
		expect(draftText(wa)).toContain("Hi Zabihullah,");
		expect(draftText(wa)).not.toContain("Kogyani");
	});

	async function open(targets: RecruitTarget[]) {
		const user = userEvent.setup();
		render(
			<NudgeRecruitPicker
				roleName="Timer"
				meetingDate="Thu, Jul 23"
				shareUrl="https://gavelup.app/club/mcf/meeting/abc"
				targets={targets}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /nudge someone/i }));
		return user;
	}
	const names = () =>
		screen.getAllByRole("option").map((o) => o.textContent ?? "");

	// protects=with an empty query available members come first then Not available, alphabetical within each; fails_when=the rank or the name tiebreak is dropped; no_claim=ranking while a query is typed beyond the matcher's own tests
	it("lists available members first, unavailable last, alphabetical within each", async () => {
		await open([
			target({ id: "1", name: "Zoe", notAvailable: false }),
			target({ id: "2", name: "Ann", notAvailable: true }),
			target({ id: "3", name: "Bea", notAvailable: false }),
			target({ id: "4", name: "Cal", notAvailable: true }),
		]);
		expect(names().map((n) => n.slice(0, 3))).toEqual([
			"Bea",
			"Zoe",
			"Ann",
			"Cal",
		]);
	});

	// protects=all four row flags still render; fails_when=renderMeta drops one; no_claim=their colours
	it("keeps every flag on the row", async () => {
		await open([
			target({
				notAvailable: true,
				alreadyRole: "Timer",
				contacted: true,
				phone: null,
				email: null,
			}),
		]);
		const row = names()[0] ?? "";
		expect(row).toContain("Not available");
		expect(row).toContain("Already: Timer");
		expect(row).toContain("Contacted");
		expect(row).toContain("no contact");
	});

	// protects=words match in any order and by preferred name, and picking opens that member's draft; fails_when=matching falls back to cmdk order-sensitive search or the pick opens the wrong row; no_claim=fuzzy matching (there is none)
	it("matches words in any order and by goes-by name", async () => {
		const user = await open([
			target({ id: "1", name: "Robert Smith", preferredName: "Bob" }),
			target({ id: "2", name: "Ada Lovelace" }),
		]);
		const box = screen.getByPlaceholderText("Search members…");
		await user.type(box, "smith rob");
		expect(names()).toHaveLength(1);
		await user.clear(box);
		await user.type(box, "bob");
		expect(names()[0]).toContain("Robert Smith");
		await user.click(screen.getAllByRole("option")[0] as HTMLElement);
		expect(await screen.findByRole("link", { name: /whatsapp/i })).toBeTruthy();
	});
});
