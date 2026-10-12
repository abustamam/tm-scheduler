// @vitest-environment jsdom
//
// The packet dialog's agenda and double-sided controls (#1166). The PDF half of
// the dialog is covered where the PDF is rendered; this file is what the
// dialog does with the numbers, layout and flags it is given: the defaults, the
// button's label and enabled state, and the two URLs it can send a person to.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PacketContext } from "#/lib/meeting-packet";

vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));

import { getPacketContext } from "#/server/packet";
import { MeetingPacketDialog } from "./meeting-packet-dialog";

const CTX: PacketContext = {
	roles: [
		{ key: "timer", name: "Timer" },
		{ key: "grammarian", name: "Grammarian" },
	],
	usesDigitalVoting: false,
	hasWord: false,
	defaultPrintLayout: "timing",
};

async function open(ctx: PacketContext = CTX) {
	vi.mocked(getPacketContext).mockResolvedValue(ctx);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MeetingPacketDialog
				open
				onOpenChange={() => {}}
				dbMeetingId="11111111-1111-4111-8111-111111111111"
				clubSlug="downtown"
				meetingId="2026-07-31"
			/>
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(screen.getByLabelText("Agenda copies")).toBeTruthy(),
	);
}

const copiesInput = () =>
	screen.getByLabelText("Agenda copies") as HTMLInputElement;
const duplexBox = () =>
	screen.getByLabelText(/Printing double-sided/) as HTMLInputElement;
const radio = (label: string) =>
	screen.getByRole("radio", {
		name: new RegExp(`^${label}`),
	}) as HTMLInputElement;
const downloadLink = () =>
	screen.getByRole("link", { name: /Download packet/ }) as HTMLAnchorElement;
const untick = (name: string) =>
	fireEvent.click(screen.getByRole("checkbox", { name }));

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	openSpy = vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("MeetingPacketDialog — agendas and double-sided (#1166)", () => {
	it("starts at 20 copies, the club's default layout, and double-sided ticked", async () => {
		await open();
		expect(copiesInput().value).toBe("20");
		expect(copiesInput().min).toBe("0");
		expect(copiesInput().max).toBe("60");
		expect(radio("Timing").checked).toBe(true);
		expect(radio("Grid").checked).toBe(false);
		expect(duplexBox().checked).toBe(true);
		expect(
			screen.getByText(/Turn on double-sided in your print dialog too/),
		).toBeTruthy();
	});

	it("falls back to grid when the context names no other default", async () => {
		await open({ ...CTX, defaultPrintLayout: "grid" });
		expect(radio("Grid").checked).toBe(true);
	});

	it("shows each layout's hint beside its radio", async () => {
		await open();
		expect(radio("Spacious").closest("label")?.textContent).toContain(
			"Two pages, larger type",
		);
	});

	it("with pieces ticked and copies > 0: the PDF href carries duplex, and one click also opens the agenda tab", async () => {
		await open();
		const link = downloadLink();
		expect(link.textContent).toBe("Download packet + open agendas");
		expect(link.getAttribute("download")).not.toBeNull();
		expect(link.getAttribute("href")).toBe(
			"/api/meetings/11111111-1111-4111-8111-111111111111/packet/pdf?piece=timer&piece=grammarian&duplex=1",
		);
		fireEvent.click(link);
		expect(openSpy).toHaveBeenCalledTimes(1);
		expect(openSpy).toHaveBeenCalledWith(
			"/club/downtown/meeting/2026-07-31/print?layout=timing&copies=20&duplex=1",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("a chosen layout and copy count go in the agenda URL; unticking double-sided drops duplex from both", async () => {
		await open();
		fireEvent.click(radio("Editorial"));
		fireEvent.change(copiesInput(), { target: { value: "35" } });
		fireEvent.click(duplexBox());
		const link = downloadLink();
		expect(link.getAttribute("href")).not.toContain("duplex");
		fireEvent.click(link);
		expect(openSpy).toHaveBeenCalledWith(
			"/club/downtown/meeting/2026-07-31/print?layout=editorial&copies=35",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("0 copies opens no tab, hides the layout radios, and says Download packet", async () => {
		await open();
		fireEvent.change(copiesInput(), { target: { value: "0" } });
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
		const link = downloadLink();
		expect(link.textContent).toBe("Download packet");
		fireEvent.click(link);
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("with no pieces ticked and copies > 0, it only opens the agenda tab", async () => {
		await open();
		untick("Timer's log");
		untick("Grammarian's log");
		const link = screen.getByRole("link", {
			name: "Open agendas",
		}) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-07-31/print?layout=timing&copies=20&duplex=1",
		);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("download")).toBeNull();
		// A plain link to a new tab, so the click handler has nothing to add.
		fireEvent.click(link);
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("with neither, the button is disabled", async () => {
		await open();
		untick("Timer's log");
		untick("Grammarian's log");
		fireEvent.change(copiesInput(), { target: { value: "0" } });
		const button = screen.getByRole("button", { name: "Nothing selected" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByRole("link", { name: /packet|agendas/ })).toBeNull();
	});

	it("an empty copies field behaves as 20, and 75 as 60", async () => {
		await open();
		untick("Timer's log");
		untick("Grammarian's log");
		fireEvent.change(copiesInput(), { target: { value: "" } });
		expect(
			screen.getByRole("link", { name: "Open agendas" }).getAttribute("href"),
		).toContain("copies=20");
		fireEvent.change(copiesInput(), { target: { value: "75" } });
		expect(
			screen.getByRole("link", { name: "Open agendas" }).getAttribute("href"),
		).toContain("copies=60");
		fireEvent.change(copiesInput(), { target: { value: "2.7" } });
		expect(
			screen.getByRole("link", { name: "Open agendas" }).getAttribute("href"),
		).toContain("copies=2&");
	});

	it("is not actionable until the meeting's context has loaded", async () => {
		vi.mocked(getPacketContext).mockReturnValue(new Promise(() => {}));
		render(
			<QueryClientProvider client={new QueryClient()}>
				<MeetingPacketDialog
					open
					onOpenChange={() => {}}
					dbMeetingId="11111111-1111-4111-8111-111111111111"
					clubSlug="downtown"
					meetingId="2026-07-31"
				/>
			</QueryClientProvider>,
		);
		const button = screen.getByRole("button", { name: /Working it out/ });
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});
