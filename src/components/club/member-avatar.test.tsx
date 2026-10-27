// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemberAvatar } from "./member-avatar";

describe("MemberAvatar", () => {
	afterEach(() => {
		cleanup();
	});

	// Pins the class only: jsdom resolves no theme. --success-foreground is
	// white on the light theme's dark palm and dark ink on the dark theme's
	// light palm (styles.css).
	it("gives the palm fill the success ink, which flips with the theme", () => {
		render(<MemberAvatar tone="palm" initials="RB" />);
		const avatar = screen.getByText("RB");
		expect(avatar.className).toContain("text-success-foreground");
		expect(avatar.className).not.toContain("text-white");
	});

	it.each([
		"lagoon",
		"amber",
	] as const)("uses dark ink, never white, on the light %s fill", (tone) => {
		render(<MemberAvatar tone={tone} initials="AA" />);
		const avatar = screen.getByText("AA");
		expect(avatar.className).toContain("text-on-accent-fill");
		expect(avatar.className).not.toContain("text-white");
	});
});
