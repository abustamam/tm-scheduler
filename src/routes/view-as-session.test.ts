// "Preview as member" must not outlive the session (#1113). `setViewAs(null)`
// used to call `requireUser()` first, so a LAPSED session could not clear the
// cookie on Sign out and the next person on the browser inherited the preview.
// Clearing needs no session now, and `getAuthContext`'s signed-out branch clears
// a leftover cookie as the second line.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	cookie: { value: undefined as string | undefined },
	setCookie: vi.fn(),
	deleteCookie: vi.fn(),
	sessionUser: { value: null as { id: string } | null },
}));

// A minimal Start adapter (the shape `slots.transport.test.ts` uses): a handler
// needs the Start runtime, so this runs the REAL handler body without it.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler: (handle: () => unknown) => () => handle(),
	}),
}));
vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-start/server", () => ({
	getCookie: () => hoisted.cookie.value,
	setCookie: hoisted.setCookie,
	deleteCookie: hoisted.deleteCookie,
}));
vi.mock("#/server/guards", () => ({
	getSessionUser: async () => hoisted.sessionUser.value,
	requireUser: async () => {
		if (!hoisted.sessionUser.value) throw new Error("Unauthorized");
		return hoisted.sessionUser.value;
	},
}));

import { VIEW_AS_COOKIE } from "#/lib/view-as";
import { getAuthContext, setViewAs } from "#/server/auth-context";

beforeEach(() => {
	hoisted.cookie.value = undefined;
	hoisted.sessionUser.value = null;
	hoisted.setCookie.mockClear();
	hoisted.deleteCookie.mockClear();
});

describe("clearing the preview without a session", () => {
	it("setViewAs(null) deletes the cookie with no session", async () => {
		await setViewAs({ data: { viewAs: null } });
		expect(hoisted.deleteCookie).toHaveBeenCalledWith(VIEW_AS_COOKIE, {
			path: "/",
		});
	});

	it("setViewAs('member') still needs a session, and sets nothing without one", async () => {
		await expect(setViewAs({ data: { viewAs: "member" } })).rejects.toThrow();
		expect(hoisted.setCookie).not.toHaveBeenCalled();
	});

	it("a signed-out getAuthContext clears a leftover preview cookie", async () => {
		hoisted.cookie.value = "member";
		const ctx = await getAuthContext();
		expect(ctx.user).toBeNull();
		expect(ctx.viewAs).toBeNull();
		expect(hoisted.deleteCookie).toHaveBeenCalledWith(VIEW_AS_COOKIE, {
			path: "/",
		});
	});

	it("an ordinary anonymous load sets no cookie header at all", async () => {
		await getAuthContext();
		expect(hoisted.deleteCookie).not.toHaveBeenCalled();
	});
});
