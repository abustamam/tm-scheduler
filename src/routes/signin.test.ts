/**
 * `/signin`'s `validateSearch`, run rather than read (#843).
 *
 * The wiring guard pins its source text; this pins what it DOES. Loosen the
 * OAuth test and every ordinary `/signin?redirect=` loses its target; tighten
 * it and the provider's signed query gets a `redirect` added, the server 307s
 * to a re-serialised URL, and consent fails with `invalid_signature`.
 */
import { describe, expect, it } from "vitest";
import { Route } from "./signin";

const validate = Route.options.validateSearch as (
	search: Record<string, unknown>,
) => { redirect?: string };

describe("/signin validateSearch", () => {
	it("adds nothing to a provider prompt, so the URL is never rewritten", () => {
		expect(validate({ sig: "abc", client_id: "c1", state: "x" })).toEqual({});
		expect(validate({ sig: "abc", client_id: 12345 })).toEqual({});
	});

	it("keeps a safe redirect and replaces an unsafe one", () => {
		expect(validate({ redirect: "/meetings/1" })).toEqual({
			redirect: "/meetings/1",
		});
		expect(validate({ redirect: "//evil.example" })).toEqual({
			redirect: "/officers",
		});
		expect(validate({})).toEqual({ redirect: "/officers" });
	});

	it("treats an empty signature as an ordinary visit", () => {
		expect(validate({ sig: "", client_id: "c1", redirect: "/me" })).toEqual({
			redirect: "/me",
		});
	});
});
