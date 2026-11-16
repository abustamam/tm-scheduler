// @vitest-environment jsdom
/**
 * protects=a role assignment from the agenda's assign sheet that was QUEUED
 *   offline does not call `actions.onMutated` (the route loader re-run that
 *   replaces the page with the offline error screen, #1648); one that went
 *   direct still does;
 * fails_when=onAssigned refreshes the route after a queued assignment, or stops
 *   refreshing after a direct one;
 * no_claim=the queue itself (use-offline-minutes tests), the cover hook's own
 *   claim/release flag (use-meeting-cover-offline.test.tsx).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfflineMinutesHandle } from "#/components/club/offline-role-writes";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

vi.mock("#/db", () => ({ db: {} }));
vi.mock("#/server/guests", () => ({ assignGuestSlot: vi.fn() }));
const { reassignSlot } = vi.hoisted(() => ({
	reassignSlot: vi.fn(async () => ({ ok: true })),
}));
vi.mock("#/server/slots", () => ({ claimSlot: vi.fn(), reassignSlot }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", async (importOriginal) =>
	(await import("#/test/router-link-stub")).routerLinkMock(
		await importOriginal<typeof import("@tanstack/react-router")>(),
	),
);

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const held = {
	id: "held",
	roleName: "Timer",
	roleDefinitionId: "rd1",
	category: "functionary",
	isSpeakerRole: false,
	slotIndex: 0,
	status: "claimed",
	assigneeId: "m-zed",
	assigneeName: "Zed Holder",
	assigneeIsGuest: false,
} as unknown as AgendaSlot;

function renderWith(
	queue: boolean,
	impl?: (direct: () => Promise<unknown>) => Promise<void>,
) {
	const onMutated = vi.fn(async () => {});
	const mutate = vi.fn(
		async (direct: () => Promise<unknown>, _build: () => unknown) => {
			if (impl) return impl(direct);
			if (!queue) await direct();
		},
	);
	const handle = {
		busy: false,
		draining: false,
		pendingCount: 0,
		opMeta: () => ({ opId: "op1", queuedAt: 1 }),
		mutate,
	} as unknown as OfflineMinutesHandle;
	const noop = async () => {};
	const actions: MeetingAgendaActions = {
		claim: noop,
		release: noop,
		addSpeaker: noop,
		removeSpeaker: noop,
		takeover: noop,
		onMutated,
	};
	render(
		<MeetingAgenda
			slots={[held]}
			viewer={meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: true,
				isGrammarian: false,
				isEditableWindow: true,
				isSignedIn: true,
			})}
			actions={actions}
			roster={[{ id: "m-ann", name: "Ann Able" }]}
			roleRecency={{}}
			roleByMemberId={{}}
			unavailableMemberIds={[]}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
			meeting={
				{
					id: "m1",
					clubId: "c1",
					scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
					status: "scheduled",
					lengthMinutes: 90,
				} as unknown as MeetingAgendaProps["meeting"]
			}
			meetingOver={false}
			contactedMemberIds={[]}
			offlineMinutes={handle}
		/>,
	);
	return { onMutated, mutate };
}

describe("MeetingAgenda assign sheet refresh with the offline queue (#1648)", () => {
	it("a queued assignment does not refresh the route", async () => {
		const { onMutated, mutate } = renderWith(true);
		await userEvent.click(screen.getByRole("button", { name: "Reassign…" }));
		await userEvent.click(await screen.findByText("Ann Able"));
		await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByText("Ann Able")).toBeNull());
		expect(onMutated).not.toHaveBeenCalled();
	});

	it("an assignment that went direct refreshes the route", async () => {
		const { onMutated } = renderWith(false);
		await userEvent.click(screen.getByRole("button", { name: "Reassign…" }));
		await userEvent.click(await screen.findByText("Ann Able"));
		await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
		expect(reassignSlot).toHaveBeenCalledTimes(1);
	});

	// A refused or failed write queued nothing and changed nothing: no refresh,
	// and it leaves no flag behind that would swallow a later refresh.
	it("a write that throws does not refresh, and the next direct one still does", async () => {
		let n = 0;
		const { onMutated, mutate } = renderWith(false, async (direct) => {
			if (++n === 1) throw new Error("still syncing");
			await direct();
		});
		await userEvent.click(screen.getByRole("button", { name: "Reassign…" }));
		await userEvent.click(await screen.findByText("Ann Able"));
		await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
		expect(onMutated).not.toHaveBeenCalled();
		await userEvent.click(await screen.findByText("Ann Able"));
		await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
	});

	// The direct call of a write that timed out into the queue resolves later:
	// it must not turn the queued verdict into a refresh.
	it("a late-resolving direct call of a queued assignment causes no refresh", async () => {
		let late: (() => Promise<unknown>) | undefined;
		const { onMutated, mutate } = renderWith(true, async (direct) => {
			late = direct;
		});
		await userEvent.click(screen.getByRole("button", { name: "Reassign…" }));
		await userEvent.click(await screen.findByText("Ann Able"));
		await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByText("Ann Able")).toBeNull());
		await late?.();
		expect(onMutated).not.toHaveBeenCalled();
	});
});
