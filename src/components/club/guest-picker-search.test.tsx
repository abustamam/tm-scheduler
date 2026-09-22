// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { assignGuestSlot } = vi.hoisted(() => ({
	assignGuestSlot: vi.fn(async () => ({ ok: true })),
}));
vi.mock("#/server/guests", () => ({ assignGuestSlot }));
vi.mock("#/server/slots", () => ({
	claimSlot: vi.fn(),
	reassignSlot: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import { AssigneePicker } from "#/components/club/table-topics-capture";

// cmdk uses layout APIs that jsdom does not implement.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver =
	ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

const clubGuests = [
	{ id: "active", name: "Active Visitor", stage: "prospect" },
	{ id: "lost", name: "Returning Visitor", stage: "lost" },
];

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("lost guest search", () => {
	it("searches existing guests in role assignment and resets for another slot", async () => {
		const user = userEvent.setup();
		const slot = {
			id: "slot-one",
			roleDefinitionId: "timer",
			status: "open" as const,
			isSpeakerRole: false,
			label: "Timer",
		};
		const props = {
			roster: [],
			roleByMemberId: {},
			unavailableIds: [],
			roleRecency: {},
			actorMemberId: "admin",
			allowGuests: true,
			clubGuests,
			onOpenChange: vi.fn(),
			onAssigned: vi.fn(),
		};
		const { rerender } = render(<AssignSlotSheet {...props} slot={slot} />);
		expect(screen.getByRole("button", { name: "Active Visitor" })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Returning Visitor" }),
		).toBeNull();
		const search = screen.getByRole("textbox", { name: "Search guests" });
		await user.type(search, "returning");
		expect(
			screen.getByRole("button", { name: "Returning Visitor" }),
		).toBeTruthy();
		await user.clear(search);
		expect(
			screen.queryByRole("button", { name: "Returning Visitor" }),
		).toBeNull();
		await user.type(search, "nobody");
		expect(
			screen.queryByRole("button", { name: "Returning Visitor" }),
		).toBeNull();
		await user.clear(search);
		await user.type(search, "Returning");
		await user.click(screen.getByRole("button", { name: "Returning Visitor" }));
		expect(assignGuestSlot).toHaveBeenCalledWith({
			data: { slotId: "slot-one", guestId: "lost" },
		});
		rerender(<AssignSlotSheet {...props} slot={{ ...slot, id: "slot-two" }} />);
		expect(
			(
				screen.getByRole("textbox", {
					name: "Search guests",
				}) as HTMLInputElement
			).value,
		).toBe("");
		expect(
			screen.queryByRole("button", { name: "Returning Visitor" }),
		).toBeNull();
	});

	it("searches existing guests in the shared topic/award picker and resets on reopening", async () => {
		const user = userEvent.setup();
		const onPick = vi.fn();
		render(
			<AssigneePicker
				label="Choose person"
				roster={[]}
				clubGuests={clubGuests}
				busy={false}
				onPick={onPick}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Choose person" }));
		expect(screen.getByRole("option", { name: /Active Visitor/ })).toBeTruthy();
		expect(
			screen.queryByRole("option", { name: /Returning Visitor/ }),
		).toBeNull();
		const search = screen.getByPlaceholderText("Search members and guests…");
		await user.type(search, "returning");
		expect(
			await screen.findByRole("option", { name: /Returning Visitor/ }),
		).toBeTruthy();
		await user.clear(search);
		expect(
			screen.queryByRole("option", { name: /Returning Visitor/ }),
		).toBeNull();
		await user.type(search, "nobody");
		expect(
			screen.queryByRole("option", { name: /Returning Visitor/ }),
		).toBeNull();
		await user.clear(search);
		await user.type(search, "Returning");
		await user.click(
			await screen.findByRole("option", { name: /Returning Visitor/ }),
		);
		expect(onPick).toHaveBeenCalledWith({ guestId: "lost" });
		await user.click(screen.getByRole("button", { name: "Choose person" }));
		expect(
			(
				screen.getByPlaceholderText(
					"Search members and guests…",
				) as HTMLInputElement
			).value,
		).toBe("");
		expect(
			screen.queryByRole("option", { name: /Returning Visitor/ }),
		).toBeNull();
	});
});
