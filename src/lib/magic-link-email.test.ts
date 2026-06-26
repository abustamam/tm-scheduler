import { describe, expect, it } from "vitest";
import { buildMagicLinkEmail } from "./magic-link-email";

describe("buildMagicLinkEmail", () => {
	const url =
		"https://gavelup.app/api/auth/magic-link/verify?token=abc123&callbackURL=/";
	const built = buildMagicLinkEmail(url);

	it("uses the GavelUp subject", () => {
		expect(built.subject).toBe("Your GavelUp sign-in link");
	});

	it("includes the url in both html and text", () => {
		expect(built.html).toContain(url);
		expect(built.text).toContain(url);
	});

	it("states the 5-minute expiry and an ignore note in both parts", () => {
		expect(built.text).toContain("expires in 5 minutes");
		expect(built.text.toLowerCase()).toContain("ignore");
		expect(built.html).toContain("expires in 5 minutes");
	});
});
