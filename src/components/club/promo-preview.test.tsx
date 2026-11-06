// @vitest-environment jsdom
//
// The live preview beside the template editor (#1537): the text it shows is the
// text the blast builders produce, a dropped line is shown struck with its
// reason, and the channel toggles stay reachable in every status.
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildEmailBlast,
	buildWhatsAppBlast,
	DEFAULT_PROMO_TEMPLATE,
	type FlyerMeeting,
	PROMO_LIMITS,
	type PromoTemplate,
	promoDate,
	promoValues,
} from "#/lib/promo-template";
import { PromoMeetingPicker } from "./promo-meeting-picker";
import { PromoPreview } from "./promo-preview";

afterEach(cleanup);

const CLUB = {
	name: "Downtown Speakers",
	slug: "downtown",
	timezone: "America/Chicago",
};
const FULL: FlyerMeeting = {
	id: "m1",
	urlKey: "2026-10-01",
	scheduledAt: "2026-10-02T00:30:00Z",
	location: "Library",
	online: true,
	joinLink: "https://meet.example.com/room",
	theme: "Beginnings",
	wordOfTheDay: "Serendipity",
	meetingNumber: 57,
	promoNote: "Bring a friend",
};
const EMPTY: FlyerMeeting = {
	...FULL,
	location: null,
	online: false,
	joinLink: null,
	theme: null,
	wordOfTheDay: null,
	meetingNumber: null,
	promoNote: null,
};
const ORIGIN = "https://gavelup.app";

function renderPreview(
	over: Partial<React.ComponentProps<typeof PromoPreview>> = {},
) {
	const props: React.ComponentProps<typeof PromoPreview> = {
		template: DEFAULT_PROMO_TEMPLATE,
		status: "ready",
		club: CLUB,
		meeting: FULL,
		isExample: false,
		origin: ORIGIN,
		logoUrl: null,
		onChannelsChange: vi.fn(),
		onRetry: vi.fn(),
		...over,
	};
	const utils = render(<PromoPreview {...props} />);
	return { ...utils, props, user: userEvent.setup() };
}

const output = (c: HTMLElement, ch: "whatsapp" | "email" | "flyer") =>
	c.querySelector<HTMLElement>(`[data-channel-output="${ch}"]`) as HTMLElement;

/** Kept lines per block, as the blast joins them: lines by "\n", blocks by a blank line. */
function keptText(root: HTMLElement): string {
	return Array.from(root.querySelectorAll("[data-block]"))
		.map((b) =>
			Array.from(b.querySelectorAll("[data-kept]"))
				.map((l) => (l.tagName === "LI" ? `- ${l.textContent}` : l.textContent))
				.join("\n"),
		)
		.filter((t) => t.trim())
		.join("\n\n");
}

describe("PromoPreview text equals the blast builders'", () => {
	const cases: [string, FlyerMeeting, string][] = [
		["every field set", FULL, ORIGIN],
		["every optional field empty", EMPTY, ORIGIN],
		["no origin", FULL, ""],
	];
	for (const [name, meeting, origin] of cases) {
		// protects=the WhatsApp and email tabs show exactly the kept text of buildWhatsAppBlast / buildEmailBlast;
		// fails_when=the preview composes a channel itself and drifts from the draft the sheet copies;
		// no_claim=dropped lines (asserted by their own tests) or the flyer tab.
		it(`${name}: kept lines equal the blast strings`, () => {
			const { container } = renderPreview({ meeting, origin });
			const values = promoValues(CLUB, meeting, origin);
			expect(keptText(output(container, "whatsapp"))).toBe(
				buildWhatsAppBlast(DEFAULT_PROMO_TEMPLATE, values).replaceAll("*", ""),
			);
			expect(keptText(output(container, "email"))).toBe(
				buildEmailBlast(DEFAULT_PROMO_TEMPLATE, values).text,
			);
		});
	}
});

describe("dropped lines", () => {
	// protects=a line holding an empty variable is struck, reads in editor form, and names the variable;
	// fails_when=it vanishes, shows stored form, or names the wrong variable; the same line filled is unstruck;
	// no_claim=the layout of the reason.
	it("a {theme} line with no theme is struck with its reason; with a theme it renders filled", () => {
		const { container, rerender, props } = renderPreview({ meeting: EMPTY });
		const wa = within(output(container, "whatsapp"));
		const struck = wa.getByText("Theme: {Theme}");
		expect(struck.tagName).toBe("S");
		expect(wa.getByText("hidden: no Theme set for this meeting")).toBeTruthy();
		rerender(<PromoPreview {...props} meeting={FULL} />);
		const filled = within(output(container, "whatsapp")).getByText(
			"Theme: Beginnings",
		);
		expect(filled.closest("s")).toBeNull();
		expect(
			within(output(container, "whatsapp")).queryByText(/no Theme set/),
		).toBeNull();
	});

	// protects=the reason follows droppedBy: online, a missing origin, and the video-call link on the flyer;
	// fails_when=every drop gets the generic "no X set" sentence;
	// no_claim=the reason for every other variable (same generic path).
	it("online, link and flyer-only reasons", () => {
		const template: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			intro: "Online: {online}\nLink: {meetingLink}",
			callToAction: "Video: {joinLink}",
			channels: {
				...DEFAULT_PROMO_TEMPLATE.channels,
				flyer: { intro: true, whyJoin: false, callToAction: true },
			},
		};
		const { container, rerender, props } = renderPreview({
			template,
			meeting: EMPTY,
			origin: "",
		});
		const wa = within(output(container, "whatsapp"));
		expect(
			wa.getByText("hidden: this meeting is not marked online"),
		).toBeTruthy();
		expect(wa.getByText("hidden: the link is not known yet")).toBeTruthy();
		expect(
			wa.getByText("hidden: no Video call link set for this meeting"),
		).toBeTruthy();
		// On the flyer, a video-call line is dropped for a reason that holds even when the meeting has one.
		rerender(<PromoPreview {...props} meeting={FULL} origin={ORIGIN} />);
		const fl = within(output(container, "flyer"));
		expect(fl.getByText("Video: {Video call link}")).toBeTruthy();
		expect(fl.getByText("hidden: never printed on the flyer")).toBeTruthy();
	});

	// protects=a dropped headline shows in the subject position of the email tab with its reason;
	// fails_when=a dropped headline leaves "Subject:" empty with no explanation;
	// no_claim=the subject string the mail app receives.
	it("a dropped headline appears in the email subject position", () => {
		const { container } = renderPreview({
			template: { ...DEFAULT_PROMO_TEMPLATE, headline: "Theme: {theme}" },
			meeting: EMPTY,
		});
		const email = output(container, "email");
		const subject = email.querySelector("p") as HTMLElement;
		expect(subject.textContent).toContain("Subject:");
		expect(within(subject).getByText("Theme: {Theme}").tagName).toBe("S");
		expect(subject.textContent).toContain("hidden: no Theme set");
	});
});

describe("toggles", () => {
	// protects=all nine include checkboxes are in the DOM at once under their exact aria-labels;
	// fails_when=inactive tabs unmount their toggles, breaking the editor's Save test selectors;
	// no_claim=that the inactive tabs are visible.
	it("mounts nine labelled checkboxes regardless of the active tab", () => {
		renderPreview();
		for (const ch of ["WhatsApp", "Email", "Flyer"]) {
			for (const part of ["Intro", "Why join", "Call to action"]) {
				expect(screen.getByLabelText(`${part} in ${ch}`)).toBeTruthy();
			}
		}
		expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(9);
	});

	// protects=unchecking Intro in WhatsApp removes the intro from the WhatsApp tab only and reports the new channels;
	// fails_when=the toggle changes another channel or does not reach onChannelsChange;
	// no_claim=what Save sends (the editor test).
	it("Intro in WhatsApp removes the intro block there and nowhere else", async () => {
		function Harness() {
			const [channels, setChannels] = useState(DEFAULT_PROMO_TEMPLATE.channels);
			return (
				<PromoPreview
					template={{ ...DEFAULT_PROMO_TEMPLATE, channels }}
					status="ready"
					club={CLUB}
					meeting={FULL}
					isExample={false}
					origin={ORIGIN}
					logoUrl={null}
					onChannelsChange={setChannels}
					onRetry={() => {}}
				/>
			);
		}
		const user = userEvent.setup();
		const { container } = render(<Harness />);
		expect(
			within(output(container, "whatsapp")).getByText("Where: Library"),
		).toBeTruthy();
		await user.click(screen.getByLabelText("Intro in WhatsApp"));
		expect(
			within(output(container, "whatsapp")).queryByText("Where: Library"),
		).toBeNull();
		expect(
			within(output(container, "email")).getByText("Where: Library"),
		).toBeTruthy();
	});
});

describe("header and statuses", () => {
	// protects=the Example meeting badge and its sentence appear only for an example meeting;
	// fails_when=the badge shows for a real meeting, or an example is not labelled;
	// no_claim=the example meeting's values.
	it("labels an example meeting and only an example meeting", () => {
		renderPreview({ isExample: true });
		expect(screen.getByText("Example meeting")).toBeTruthy();
		expect(
			screen.getByText(
				"No meeting is scheduled yet, so this shows an example.",
			),
		).toBeTruthy();
		cleanup();
		renderPreview();
		expect(screen.queryByText("Example meeting")).toBeNull();
		expect(screen.getByText("Preview of your unsaved changes")).toBeTruthy();
	});

	// protects=the tabs and toggles render while loading and after a failure; only the output area changes, and Try again calls onRetry;
	// fails_when=a failed context hides the toggles, or Try again is missing;
	// no_claim=the retry's result (the editor test).
	it("loading shows a skeleton and error shows the sentence, both with the toggles", async () => {
		const loading = renderPreview({
			status: "loading",
			club: null,
			meeting: null,
		});
		expect(
			loading.container.querySelector("[data-slot=skeleton]"),
		).not.toBeNull();
		expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(9);
		cleanup();
		const failed = renderPreview({
			status: "error",
			club: null,
			meeting: null,
		});
		expect(
			screen.getAllByText("Couldn't load a meeting for the preview.").length,
		).toBeGreaterThan(0);
		expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(9);
		await failed.user.click(
			screen.getAllByRole("button", { name: "Try again", hidden: true })[0],
		);
		expect(failed.props.onRetry).toHaveBeenCalledTimes(1);
	});

	// protects=the WhatsApp count line warns past the soft limit and not under it;
	// fails_when=the warning class is missing past the limit or present under it;
	// no_claim=the text of the warning beyond the limit it quotes.
	it("the WhatsApp count turns warning past the soft limit", () => {
		const long: PromoTemplate = {
			...DEFAULT_PROMO_TEMPLATE,
			intro: "x".repeat(PROMO_LIMITS.whatsappSoft),
		};
		const a = renderPreview({ template: long });
		const warn = within(
			output(a.container, "whatsapp").parentElement as HTMLElement,
		).getByText(/characters — long for a group chat/);
		expect(warn.className).toContain("text-warning-foreground");
		cleanup();
		const b = renderPreview({
			template: { ...DEFAULT_PROMO_TEMPLATE, whyJoin: ["One"] },
		});
		const ok = within(
			output(b.container, "whatsapp").parentElement as HTMLElement,
		).getByText(/\d+ characters/);
		expect(ok.className).not.toContain("text-warning-foreground");
	});

	// protects=only the active tab's panel is displayed while all three stay mounted;
	// fails_when=a force-mounted panel shows beside the active one (Radix sets no hidden on it);
	// no_claim=the CSS that implements the hiding (the class is read from the DOM, the 375px check sees it).
	it("hides the inactive panels but keeps them mounted", async () => {
		const { container, user } = renderPreview();
		const panels = () =>
			Array.from(container.querySelectorAll("[role=tabpanel]")).map((p) => [
				p.getAttribute("data-state"),
				p.className.includes("data-[state=inactive]:hidden"),
			]);
		expect(panels()).toEqual([
			["active", true],
			["inactive", true],
			["inactive", true],
		]);
		await user.click(screen.getByRole("tab", { name: "Email" }));
		expect(panels().map((p) => p[0])).toEqual([
			"inactive",
			"active",
			"inactive",
		]);
	});

	// protects=the Flyer tab mounts exactly one flyer square, a thumbnail with no export copy;
	// fails_when=the preview mounts the off-screen 1080px export copy as well;
	// no_claim=the thumbnail's pixels.
	it("mounts exactly one flyer square", () => {
		const { container } = renderPreview();
		expect(container.querySelectorAll("[data-flyer-square]")).toHaveLength(1);
	});
});

describe("source", () => {
	// protects=the preview never injects an HTML string;
	// fails_when=the component uses dangerouslySetInnerHTML (a template line then runs as markup);
	// no_claim=other injection routes such as innerHTML assignment.
	it("never uses dangerouslySetInnerHTML", () => {
		const src = readFileSync("src/components/club/promo-preview.tsx", "utf8");
		expect(src.length).toBeGreaterThan(500);
		expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
	});
});

describe("PromoMeetingPicker", () => {
	// protects=each option reads the date, then the theme when there is one; changing it reports the id;
	// fails_when=the option text drifts from what the sheet showed or onChange is not wired;
	// no_claim=when the picker is shown (the sheet and editor decide).
	it("lists promoDate and theme and reports the choice", async () => {
		const onChange = vi.fn();
		const other = {
			...FULL,
			id: "m2",
			theme: null,
			scheduledAt: "2026-10-09T00:30:00Z",
		};
		render(
			<PromoMeetingPicker
				id="p"
				meetings={[FULL, other]}
				timezone={CLUB.timezone}
				value="m1"
				onChange={onChange}
			/>,
		);
		const select = screen.getByLabelText("Meeting") as HTMLSelectElement;
		expect(select.options[0].textContent).toBe(
			`${promoDate(FULL.scheduledAt, CLUB.timezone)} — Beginnings`,
		);
		expect(select.options[1].textContent).toBe(
			promoDate(other.scheduledAt, CLUB.timezone),
		);
		await userEvent.setup().selectOptions(select, "m2");
		expect(onChange).toHaveBeenCalledWith("m2");
	});
});
