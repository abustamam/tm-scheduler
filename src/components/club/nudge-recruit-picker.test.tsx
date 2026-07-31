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
});
