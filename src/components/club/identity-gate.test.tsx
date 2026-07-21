// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredMember } from "#/lib/member-identity";

// Stub the roster server fns the dialog's PickNameForm calls.
vi.mock("#/server/members", () => ({
	listMembers: vi.fn(async () => [
		{ id: "m-jane", name: "Jane Doe", officerPositions: [] },
	]),
	addMember: vi.fn(async () => ({ id: "m-new" })),
}));

import { IdentityGateProvider, useRequireIdentity } from "./identity-gate";

const CLUB_UUID = "11111111-1111-1111-1111-111111111111";
const CLUB_SLUG = "club-slug";

function Harness({ onResult }: { onResult: (v: unknown) => void }) {
	const { member, requireIdentity } = useRequireIdentity();
	return (
		<div>
			<p>member: {member ? member.name : "none"}</p>
			<button
				type="button"
				onClick={async () => onResult(await requireIdentity())}
			>
				act
			</button>
		</div>
	);
}

function renderHarness(onResult: (v: unknown) => void) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<IdentityGateProvider
				clubUuid={CLUB_UUID}
				clubSlug={CLUB_SLUG}
				sessionMember={null}
			>
				<Harness onResult={onResult} />
			</IdentityGateProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => clearStoredMember(CLUB_SLUG));
afterEach(() => {
	cleanup();
	clearStoredMember(CLUB_SLUG);
});

describe("IdentityGateProvider", () => {
	it("opens the dialog when no identity and resolves with the picked member", async () => {
		const results: unknown[] = [];
		renderHarness((v) => results.push(v));
		await userEvent.click(screen.getByText("act"));
		// Dialog opens with the roster.
		await userEvent.click(await screen.findByText("Jane Doe"));
		await waitFor(() =>
			expect(results).toEqual([{ id: "m-jane", name: "Jane Doe" }]),
		);
		// Identity now persists — the bar reflects it.
		expect(screen.getByText("member: Jane Doe")).toBeTruthy();
	});

	it("resolves null when the dialog is dismissed (abort)", async () => {
		const results: unknown[] = [];
		renderHarness((v) => results.push(v));
		await userEvent.click(screen.getByText("act"));
		await screen.findByText("Jane Doe");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(results).toEqual([null]));
	});
});
