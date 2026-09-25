// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellContext } from "#/components/app-shell";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { ResourcesShell } from "./resources-shell";

// The real <AppShell> needs a club's worth of context; a marker is enough to
// tell the two branches apart. `impersonation` is a server fn module (pg).
vi.mock("#/components/app-shell", () => ({
	AppShell: ({ children }: { children: ReactNode }) => (
		<div data-testid="app-shell">{children}</div>
	),
	shellPropsFromContext: () => ({}),
}));
vi.mock("#/server/impersonation", () => ({ endImpersonation: vi.fn() }));
vi.mock("#/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));

afterEach(cleanup);

const MEMBER: ShellContext = {
	user: { id: "u1", name: "Ada", email: "ada@example.com" },
	clubs: [{ clubId: "c1", name: "Club", clubNumber: null, clubRole: "member" }],
	currentMemberId: "m1",
	activeClubId: "c1",
	officerPositions: [],
	isSuperadmin: false,
	impersonating: null,
};

const CTA_HEADLINE = "Your club could run its meetings here.";

async function renderShell(props: {
	shell?: boolean;
	authCtx?: ShellContext | null;
}) {
	await renderUnderMemoryRouter(
		<ResourcesShell {...props}>
			<p>article body</p>
		</ResourcesShell>,
	);
	// Every case renders its children; a branch that dropped them would make
	// the absence assertion below vacuous.
	expect(screen.getByText("article body")).toBeTruthy();
}

describe("ResourcesShell's marketing CTA (#870)", () => {
	it("is present for an anonymous visitor (shell false)", async () => {
		await renderShell({ shell: false, authCtx: null });
		expect(screen.queryByTestId("app-shell")).toBeNull();
		expect(screen.getByText(CTA_HEADLINE)).toBeTruthy();
	});

	it("is present for a signed-in user with no club (shell true, authCtx null)", async () => {
		await renderShell({ shell: true, authCtx: null });
		expect(screen.queryByTestId("app-shell")).toBeNull();
		expect(screen.getByText(CTA_HEADLINE)).toBeTruthy();
	});

	it("is absent for a member, inside the app shell", async () => {
		await renderShell({ shell: true, authCtx: MEMBER });
		expect(screen.getByTestId("app-shell")).toBeTruthy();
		expect(screen.queryByText(CTA_HEADLINE)).toBeNull();
	});
});
