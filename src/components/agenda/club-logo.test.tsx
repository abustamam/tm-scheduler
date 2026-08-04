// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClubLogo } from "./club-logo";

afterEach(cleanup);

describe("ClubLogo", () => {
	it("renders nothing at all when logoUrl is null", () => {
		const { container } = render(<ClubLogo logoUrl={null} />);
		// Not just "no img" — no wrapper, no spacer, nothing in the subtree, so a
		// club with no logo prints byte-identical to before this feature existed.
		expect(container.innerHTML).toBe("");
	});

	it("renders an img pointed at the given, already-versioned URL", () => {
		const { container } = render(
			<ClubLogo logoUrl="/api/club/abc-123/logo?v=1690000000000" />,
		);
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe(
			"/api/club/abc-123/logo?v=1690000000000",
		);
	});

	it("is decorative: empty alt text so a screen reader announces nothing (never names a mark)", () => {
		const { container } = render(
			<ClubLogo logoUrl="/api/club/abc-123/logo?v=1" />,
		);
		expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
	});

	// Fixed height + auto width + a max-width cap, not a fixed box: a club's
	// logo is either a wide wordmark or a square crest, and a box that forces
	// both dimensions distorts one of them.
	it("sizes the image to a fixed height with capped, unconstrained-ratio width", () => {
		const { container } = render(
			<ClubLogo logoUrl="/api/club/abc-123/logo?v=1" />,
		);
		const img = container.querySelector("img") as HTMLImageElement;
		expect(img.style.height).toBe("48px");
		expect(img.style.width).toBe("auto");
		expect(img.style.maxWidth).toBe("180px");
		expect(img.style.objectFit).toBe("contain");
	});
});
