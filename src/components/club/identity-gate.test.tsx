// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredMember, storeMember } from "#/lib/member-identity";

// Stub the roster server fns the dialog's PickNameForm calls.
vi.mock("#/server/members", () => ({
	listMembers: vi.fn(async () => [
		{ id: "m-jane", name: "Jane Doe", officerPositions: [] },
	]),
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

	it("with a session member, requireIdentity resolves immediately and never opens the dialog", async () => {
		const results: unknown[] = [];
		const qc = new QueryClient();
		render(
			<QueryClientProvider client={qc}>
				<IdentityGateProvider
					clubUuid={CLUB_UUID}
					clubSlug={CLUB_SLUG}
					sessionMember={{ id: "m-sess", name: "Session User" }}
				>
					<Harness onResult={(v) => results.push(v)} />
				</IdentityGateProvider>
			</QueryClientProvider>,
		);
		await userEvent.click(screen.getByText("act"));
		await waitFor(() =>
			expect(results).toEqual([{ id: "m-sess", name: "Session User" }]),
		);
		// No dialog was ever shown (PickNameForm's roster never renders).
		expect(screen.queryByText("Jane Doe")).toBeNull();
	});

	it("single-flight: concurrent requireIdentity calls all resolve with the one pick", async () => {
		const results: unknown[] = [];
		function MultiHarness() {
			const { requireIdentity } = useRequireIdentity();
			return (
				<button
					type="button"
					onClick={() => {
						void requireIdentity().then((v) => results.push(v));
						void requireIdentity().then((v) => results.push(v));
					}}
				>
					act2
				</button>
			);
		}
		const qc = new QueryClient();
		render(
			<QueryClientProvider client={qc}>
				<IdentityGateProvider
					clubUuid={CLUB_UUID}
					clubSlug={CLUB_SLUG}
					sessionMember={null}
				>
					<MultiHarness />
				</IdentityGateProvider>
			</QueryClientProvider>,
		);
		await userEvent.click(screen.getByText("act2"));
		await userEvent.click(await screen.findByText("Jane Doe"));
		await waitFor(() => expect(results).toHaveLength(2));
		expect(results).toEqual([
			{ id: "m-jane", name: "Jane Doe" },
			{ id: "m-jane", name: "Jane Doe" },
		]);
	});
});

/**
 * The `sessionMember` field the context gained for #665's `?as=` seeding.
 *
 * Worth its own block because the wrong wiring is a ONE-TOKEN slip that
 * typechecks and passes everything else: the provider computes
 * `const effective = sessionMember ?? picked`, so exposing `effective` instead
 * of `sessionMember` would make `resolveAsSeed` see a truthy "session" for
 * every anonymous visitor who has already picked a name — and `?as=` would
 * silently stop seeding for returning members, the largest group these nudge
 * links target, with the whole suite green.
 */
function SessionProbe() {
	const { member, sessionMember } = useRequireIdentity();
	return (
		<div>
			<p>effective: {member ? member.id : "none"}</p>
			<p>session: {sessionMember ? sessionMember.id : "none"}</p>
		</div>
	);
}

function renderProbe(sessionMember: { id: string; name: string } | null) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<IdentityGateProvider
				clubUuid={CLUB_UUID}
				clubSlug={CLUB_SLUG}
				sessionMember={sessionMember}
			>
				<SessionProbe />
			</IdentityGateProvider>
		</QueryClientProvider>,
	);
}

describe("IdentityGateProvider → sessionMember (#665)", () => {
	it("is null for an anonymous visitor who has ALREADY picked a name", async () => {
		storeMember(CLUB_SLUG, { id: "m-picked", name: "Picked" });
		renderProbe(null);
		// The effective identity resolves to the pick…
		await waitFor(() =>
			expect(screen.getByText("effective: m-picked")).toBeTruthy(),
		);
		// …but sessionMember must stay null. This is the assertion that fails if
		// someone exposes `effective` here.
		expect(screen.getByText("session: none")).toBeTruthy();
	});

	it("is the SESSION member, not the pick, when both exist", async () => {
		storeMember(CLUB_SLUG, { id: "m-picked", name: "Picked" });
		renderProbe({ id: "m-session", name: "Signed In" });
		await waitFor(() =>
			expect(screen.getByText("session: m-session")).toBeTruthy(),
		);
		// And the session wins the effective identity, which is the pre-existing
		// rule this field must not disturb.
		expect(screen.getByText("effective: m-session")).toBeTruthy();
	});

	it("is null when there is neither a session nor a pick", () => {
		renderProbe(null);
		expect(screen.getByText("session: none")).toBeTruthy();
		expect(screen.getByText("effective: none")).toBeTruthy();
	});
});
