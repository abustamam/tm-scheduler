// @vitest-environment jsdom
//
// `/oauth/consent` rendered (#843): the name it shows, what Approve and
// Decline send, and where each then goes. The provider's side — that the POST
// verifies, grants on accept, records nothing on decline, and refuses an
// account change — is DB-backed and lives in
// `oauth-consent.integration.test.ts`; this file pins the half only a render
// can see.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentClientLookup } from "#/server/oauth-consent-logic";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// The real module reaches `#/lib/auth` → `#/db` → `pg`.
vi.mock("#/server/oauth-consent", () => ({ getOAuthConsentClient: vi.fn() }));
// `window.location`'s methods cannot be spied on in jsdom.
vi.mock("#/lib/browser-location", () => ({
	assignLocation: vi.fn(),
	replaceLocation: vi.fn(),
}));

import { assignLocation, replaceLocation } from "#/lib/browser-location";
import { Route } from "./oauth.consent";

/**
 * What the provider puts in the URL, including the characters the page must
 * not re-encode: `+`, `/` and `=` in the base64 signature and a repeated key.
 */
const SIGNED_QUERY =
	"response_type=code&client_id=client-1&scope=openid+profile" +
	"&redirect_uri=https%3A%2F%2Fclient.example%2Fcb" +
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

const reply = (status: number, body: unknown) =>
	fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

/** The JSON body of the one consent POST the page made. */
const postedBody = () =>
	JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);

beforeEach(() => {
	window.history.replaceState(null, "", `/oauth/consent?${SIGNED_QUERY}`);
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.mocked(assignLocation).mockReset();
	vi.mocked(replaceLocation).mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const signedIn = (name: string | null): ConsentClientLookup => ({
	signedIn: true,
	userId: "user-a",
	email: "officer@example.com",
	client: name === null ? null : { clientId: "client-1", name },
});

describe("/oauth/consent", () => {
	it("names the client from the server lookup and the account approving", async () => {
		await mount(signedIn("Claude"));
		expect(
			screen.getByRole("heading", { name: "Connect Claude?" }),
		).toBeTruthy();
		expect(screen.getByText("Signed in as officer@example.com.")).toBeTruthy();
	});

	it("does not promise a confirmation step the server does not enforce", async () => {
		await mount(signedIn("Claude"));
		expect(document.body.textContent).not.toMatch(/confirm each change/i);
		expect(document.body.textContent).toMatch(
			/happen as soon as the app makes them/,
		);
	});

	it("says it could not identify a client the lookup did not find, and leads with Decline", async () => {
		await mount(signedIn(null));
		expect(
			screen.getByRole("heading", { name: "Connect an app?" }),
		).toBeTruthy();
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("couldn't identify this app");
		expect(alert.textContent).toContain("client-1");
		// The filled, primary button is Decline for an unidentified app.
		const decline = screen.getByRole("button", { name: "Decline" });
		const approve = screen.getByRole("button", { name: "Approve" });
		expect(decline.className).toContain("bg-primary");
		expect(approve.className).not.toContain("bg-primary");
	});

	it("Approve posts the URL's query byte-for-byte with the displayed user, then follows the redirect", async () => {
		reply(200, { redirect: true, url: "https://client.example/cb?code=abc" });
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() =>
			expect(assignLocation).toHaveBeenCalledExactlyOnceWith(
				"https://client.example/cb?code=abc",
			),
		);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/auth/oauth2/consent");
		expect(init.method).toBe("POST");
		// Not re-serialised: the provider signs this exact string, and a
		// round trip through a search parser turns `%2B` into a space.
		expect(postedBody()).toEqual({
			accept: true,
			oauth_query: SIGNED_QUERY,
			expected_user_id: "user-a",
		});
	});

	it("follows redirect_uri when the provider answers with that instead of url", async () => {
		reply(200, { redirect_uri: "https://client.example/cb?code=xyz" });
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() =>
			expect(assignLocation).toHaveBeenCalledWith(
				"https://client.example/cb?code=xyz",
			),
		);
	});

	it("Decline posts accept:false, stays put, and offers the app's return link", async () => {
		reply(200, {
			redirect: true,
			url: "https://client.example/cb?error=access_denied",
		});
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Decline" }));
		await screen.findByRole("heading", { name: "Request declined" });
		expect(postedBody()).toMatchObject({ accept: false });
		expect(assignLocation).not.toHaveBeenCalled();
		expect(
			screen
				.getByRole("link", { name: "Return to the app" })
				.getAttribute("href"),
		).toBe("https://client.example/cb?error=access_denied");
		// It does not claim to undo an earlier approval it cannot undo.
		expect(document.body.textContent).toMatch(/doesn't disconnect it/);
		expect(screen.getByRole("status")).toBeTruthy();
	});

	it("does not claim to know the outcome when an approval's response is lost", async () => {
		fetchMock.mockRejectedValue(new TypeError("network"));
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await screen.findByRole("heading", {
			name: "We couldn't confirm the connection",
		});
		// No Decline left to press: it would not undo an approval that landed.
		expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
		expect(assignLocation).not.toHaveBeenCalled();
	});

	it("treats an approval whose success body is unreadable as uncertain, not refused", async () => {
		// Headers arrived with a 200, then the body did not: the provider may
		// already have recorded the approval, so Decline must not come back.
		fetchMock.mockResolvedValue(new Response("{not json", { status: 200 }));
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await screen.findByRole("heading", {
			name: "We couldn't confirm the connection",
		});
		expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
		expect(assignLocation).not.toHaveBeenCalled();
	});

	it("treats a server error after Approve as uncertain — consent may already be written", async () => {
		reply(500, { error: "server_error" });
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await screen.findByRole("heading", {
			name: "We couldn't confirm the connection",
		});
		expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
	});

	it("says the account changed when the server refuses a mismatched approval", async () => {
		reply(400, { error: "account_changed" });
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await screen.findByRole("heading", {
			name: "You're signed in as someone else now",
		});
		expect(assignLocation).not.toHaveBeenCalled();
	});

	it("shows a plain error when the provider refuses the approval, and lets them try again", async () => {
		reply(400, { error: "invalid_signature" });
		await mount(signedIn("Claude"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"expired or was changed",
		);
		expect(
			(screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("renders an error state, not a throw, for a malformed query", async () => {
		await mount(null, { ok: false });
		expect(
			screen.getByRole("heading", { name: "This link doesn't work" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});

	it("sends a signed-out visitor to /signin with the authorize continuation", async () => {
		await mount({ signedIn: false });
		expect(screen.getByText("Taking you to sign in…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
		await waitFor(() => expect(replaceLocation).toHaveBeenCalledOnce());
		const href = vi.mocked(replaceLocation).mock.calls[0]?.[0] as string;
		const target = new URL(href, "https://x.example").searchParams.get(
			"redirect",
		);
		expect(new URL(href, "https://x.example").pathname).toBe("/signin");
		expect(target?.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
		expect(target).not.toContain("sig=");
	});

	it("is served with anti-framing headers", () => {
		const headers = (Route.options.headers as () => Record<string, string>)();
		expect(headers["X-Frame-Options"]).toBe("DENY");
		expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
	});
});
