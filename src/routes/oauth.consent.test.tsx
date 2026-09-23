// @vitest-environment jsdom
//
// `/oauth/consent` rendered (#843): the name it shows, and what Approve and
// Decline actually send. The provider's side of both — that the POST verifies,
// grants on accept and records nothing on decline — is DB-backed and lives in
// `oauth-consent.integration.test.ts`; this file pins the half only a render
// can see.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentClientLookup } from "#/server/oauth-consent-logic";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// The real module reaches `#/lib/auth` → `#/db` → `pg`.
vi.mock("#/server/oauth-consent", () => ({ getOAuthConsentClient: vi.fn() }));

import { Route } from "./oauth.consent";

/**
 * What the provider puts in the URL, including the characters the page must
 * not re-encode: `+`, `/` and `=` in the base64 signature and a repeated key.
 */
const SIGNED_QUERY =
	"response_type=code&client_id=client-1&scope=openid+profile" +
	"&exp=1790171984&ba_iat=1790171384881&ba_param=client_id&ba_param=scope" +
	"&sig=fgO2%2BZDx%2FaOPg69X3t%3D";

const fetchMock = vi.fn();

function mount(
	lookup: ConsentClientLookup | null,
	query: { ok: true; clientId: string; scopes: string[] } | { ok: false } = {
		ok: true,
		clientId: "client-1",
		scopes: [],
	},
) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({ query, lookup } as never);
	const Component = Route.options.component as React.ComponentType;
	return renderUnderMemoryRouter(<Component />);
}

beforeEach(() => {
	window.history.replaceState(null, "", `/oauth/consent?${SIGNED_QUERY}`);
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const signedIn = (name: string | null): ConsentClientLookup => ({
	signedIn: true,
	email: "officer@example.com",
	client: name === null ? null : { clientId: "client-1", name },
});

describe("/oauth/consent", () => {
	it("names the client from the server lookup and the account approving", async () => {
		await mount(signedIn("Claude"));
		expect(screen.getByText("Connect Claude?")).toBeTruthy();
		expect(screen.getByText("Signed in as officer@example.com.")).toBeTruthy();
	});

	it("says it could not identify a client the lookup did not find, and shows the raw id", async () => {
		await mount(signedIn(null));
		expect(screen.getByText("Connect an app?")).toBeTruthy();
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("couldn't identify this app");
		expect(alert.textContent).toContain("client-1");
	});

	it("Approve posts accept:true with the URL's query byte-for-byte", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ redirect: true, url: "about:blank#ok" }), {
				status: 200,
			}),
		);
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/auth/oauth2/consent");
		expect(init.method).toBe("POST");
		// Not re-serialised: the provider signs this exact string, and a
		// round trip through a search parser turns `%2B` into a space.
		expect(JSON.parse(init.body as string)).toEqual({
			accept: true,
			oauth_query: SIGNED_QUERY,
		});
	});

	it("Decline posts accept:false and says nothing was connected, without leaving", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					redirect: true,
					url: "https://client.example/cb?error=access_denied",
				}),
				{ status: 200 },
			),
		);
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Decline" }));
		await screen.findByText("Nothing was connected");
		expect(
			JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
		).toEqual({ accept: false, oauth_query: SIGNED_QUERY });
		expect(window.location.pathname).toBe("/oauth/consent");
	});

	it("shows a plain error when the provider refuses the approval", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: "invalid_signature" }), {
				status: 400,
			}),
		);
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"expired or was changed",
		);
	});

	it("renders an error state, not a throw, for a malformed query", async () => {
		await mount(null, { ok: false });
		expect(screen.getByText("This link doesn't work")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});

	it("offers no decision to a signed-out visitor", async () => {
		await mount({ signedIn: false });
		expect(screen.getByText("Taking you to sign in…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});
});
