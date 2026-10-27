// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemberAvatar } from "./member-avatar";

describe("MemberAvatar", () => {
	afterEach(() => {
		cleanup();
	});

	it("keeps white initials on the dark palm fill", () => {
		render(<MemberAvatar tone="palm" initials="RB" />);
		expect(screen.getByText("RB").className).toContain("text-white");
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
