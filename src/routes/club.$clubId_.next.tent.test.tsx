// @vitest-environment jsdom
//
// The next-meeting table tent route (#1210): the loader's narrowed payload and
// 404, the <title>, and the sheet itself: two faces, one flipped, each with the
// club name and a QR whose target is `/club/<slug>/next?room=1`.
import { isNotFound, notFound } from "@tanstack/react-router";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
// The QR is stubbed so its encoded value is assertable as text.
vi.mock("qrcode.react", () => ({
	QRCodeSVG: ({ value }: { value: string }) => (
		<svg data-testid="tent-qr" data-value={value} />
	),
}));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { Route } from "./club.$clubId_.next.tent";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const loader = Route.options.loader as (a: unknown) => Promise<unknown>;

describe("next-meeting tent route: loader and head", () => {
	it("ships only the club's name and slug", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: "c1",
			name: "Downtown Toastmasters",
			slug: "downtown",
			timezone: "America/Chicago",
		} as never);
		await expect(
			loader({ params: { clubId: "downtown" }, location: {} }),
		).resolves.toEqual({
			club: { name: "Downtown Toastmasters", slug: "downtown" },
		});
	});

	it("an unknown or archived club is a 404", async () => {
		vi.mocked(resolveClubOrRedirect).mockImplementation(async () => {
			throw notFound();
		});
		const err = await loader({
			params: { clubId: "nope" },
			location: {},
		}).catch((e: unknown) => e);
		expect(isNotFound(err)).toBe(true);
	});

	it("titles the page with the club name (the saved-PDF filename)", () => {
		const head = Route.options.head as (a: unknown) => {
			meta: Array<Record<string, string>>;
		};
		const meta = head({
			loaderData: { club: { name: "Downtown Toastmasters", slug: "downtown" } },
		}).meta;
		expect(meta[0].title).toBe(
			"Downtown Toastmasters — Next meeting table tent",
		);
		expect(meta).toContainEqual({
			name: "robots",
			content: "noindex, nofollow",
		});
	});
});

describe("next-meeting tent route: the sheet", () => {
	async function renderTent(name = "Downtown Toastmasters") {
		vi.spyOn(Route, "useLoaderData").mockReturnValue({
			club: { name, slug: "downtown" },
		} as never);
		const Component = Route.options.component as () => React.ReactElement;
		await renderUnderMemoryRouter(<Component />);
	}

	it("has two faces, one turned half a turn, each with the club name", async () => {
		await renderTent();
		const faces = screen.getAllByTestId("tent-face");
		expect(faces.map((f) => f.getAttribute("data-flipped"))).toEqual([
			"true",
			"false",
		]);
		expect((faces[0] as HTMLElement).style.transform).toBe("rotate(180deg)");
		expect((faces[1] as HTMLElement).style.transform).toBe("");
		const names = screen.getAllByTestId("tent-club-name");
		expect(names).toHaveLength(2);
		for (const n of names) expect(n.textContent).toBe("Downtown Toastmasters");
	});

	it("both QRs target /next?room=1 on the visitor's origin", async () => {
		await renderTent();
		const expected = `${window.location.origin}/club/downtown/next?room=1`;
		await waitFor(() =>
			expect(screen.getAllByTestId("tent-qr")).toHaveLength(2),
		);
		for (const qr of screen.getAllByTestId("tent-qr")) {
			expect(qr.getAttribute("data-value")).toBe(expected);
		}
	});

	it("is one .agenda-page, so it prints as a single sheet", async () => {
		await renderTent();
		expect(document.querySelectorAll(".agenda-page")).toHaveLength(1);
	});

	it("a long name drops a size", async () => {
		await renderTent("The Very Long Named Downtown Evening Toastmasters Club");
		const [n] = screen.getAllByTestId("tent-club-name");
		expect((n as HTMLElement).style.fontSize).toBe("34px");
	});
});
