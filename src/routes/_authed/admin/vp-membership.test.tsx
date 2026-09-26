// @vitest-environment jsdom
//
// Component tests for the guest pipeline card's CONTACT LINE (the WhatsApp
// phone-links change). The card used to join phone and email into one string;
// they are separate elements now, which means the "·" between them is an
// element with a gate of its own — and that gate is the only piece of real
// conditional logic the change introduced.
//
// It exists because nothing else can see that gate. The `no-tel-links` source
// guard pins the substrings `phone={guest.phone}` / `name={guest.name}` and is
// structurally blind to the separator, the `hasPhone || hasEmail` outer gate,
// the `mailto:` anchor, and where `truncate` sits. The server suite stops at
// the payload. So the four states below — both present, phone blank, email
// absent, neither — are covered here or nowhere.
//
// The gate deliberately tests the TRIMMED value, because `WhatsAppPhoneLink`
// trims before deciding to render nothing. A gate on the raw column would leave
// a "·" dangling in front of the email for a whitespace-only phone; the second
// test is what holds that.
//
// Pattern follows vpe-dashboard.test.tsx / club-settings.test.tsx: mock the
// server-fn modules (they reach `#/db` → `pg`, which must not load under
// jsdom), stub `Route.useLoaderData`, and render `Route.options.component`
// directly rather than running the real loader.
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CONVERT_DEMOTED_MESSAGE,
	CONVERT_REACTIVATED_MESSAGE,
	type ConvertNotice,
} from "#/lib/guest-convert";
import { ROSTER_CONFLICT_COPY } from "#/lib/roster-conflict-copy";
import {
	convertGuestToMember,
	type NextMeetingSummary,
	type PipelineGuestRow,
	recordGuestInvite,
} from "#/server/guest-pipeline";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/guest-pipeline", () => ({
	convertGuestToMember: vi.fn(),
	deleteGuest: vi.fn(),
	getGuestInviteContext: vi.fn(),
	getGuestPipeline: vi.fn(),
	getLinkCandidates: vi.fn(),
	linkGuestToMember: vi.fn(),
	recordGuestInvite: vi.fn(),
	setGuestStage: vi.fn(),
	undoGuestConversion: vi.fn(),
	unlinkGuestFromMember: vi.fn(),
	updateGuest: vi.fn(),
}));
vi.mock("#/server/clubs", () => ({
	getClubByIdentifier: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { Route } from "./vp-membership";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** `firstVisitAt: null` on purpose — a first-visit date puts its OWN " · " in
 *  the line below the contact line, and these tests query for "·" by text. */
function guestRow(over: Partial<PipelineGuestRow> = {}): PipelineGuestRow {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "Ada Guest",
		preferredName: null,
		email: "ada@example.com",
		// The DISPLAY value (server-coalesced to E.164) — what the card links to.
		phone: "+14155552671",
		// The stored column verbatim — what the edit dialog prefills. Deliberately
		// a DIFFERENT string: both fields hold plausible numbers, so a dialog bound
		// to `phone` by mistake would still show one, and identical fixtures would
		// make the binding untestable.
		phoneRaw: "415-555-2671 x12",
		stage: "prospect",
		convertedMembershipId: null,
		linkReversible: false,
		conversionUndoable: false,
		firstVisitAt: null,
		visitCount: 0,
		heldSlotCount: 0,
		lastInvite: null,
		inviteCount: 0,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		...over,
	};
}

/** No next meeting by default, so the invite control is in its disabled state
 *  and renders no extra links into the suites that predate it. */
const NO_NEXT_MEETING: NextMeetingSummary = {
	timezone: "America/Los_Angeles",
	nextMeeting: null,
};

async function renderRoute(
	guests: PipelineGuestRow[],
	inviteContext: NextMeetingSummary = NO_NEXT_MEETING,
) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		guests,
		clubId: "22222222-2222-4222-8222-222222222222",
		clubName: "Downtown Club",
		clubSlug: "downtown",
		inviteContext,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);

	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

/**
 * The text column of one guest's card — the name line, the contact line and the
 * visits line. Scoping every assertion to this element is what keeps a test
 * from passing on some other guest's contact details.
 */
function cardTextColumn(name: string): HTMLElement {
	const nameLine = screen.getByText(name);
	const column = nameLine.parentElement;
	expect(column, `no text column around "${name}"`).toBeTruthy();
	return column as HTMLElement;
}

describe("VP Membership guest card — contact line", () => {
	it("links the phone to WhatsApp and separates it from the email", async () => {
		await renderRoute([guestRow()]);
		const card = within(cardTextColumn("Ada Guest"));

		const phone = card.getByRole("link", { name: /\+14155552671/ });
		expect(phone.getAttribute("href")).toContain("whatsapp");
		expect(phone.getAttribute("title")).toBe("Message Ada Guest on WhatsApp");
		// The email keeps its mailto: — only the phone changed scheme.
		expect(
			card.getByRole("link", { name: "ada@example.com" }).getAttribute("href"),
		).toBe("mailto:ada@example.com");
		expect(card.getByText("·")).toBeTruthy();
	});

	it("keeps the separator bound to the email so they wrap together", async () => {
		// The contact line became wrappable when phone and email stopped being one
		// truncated string. As its own flex item the "·" could be pushed to the end
		// of line 1 with the address starting line 2 — a dangling separator that
		// reads as punctuation on the phone number instead of a divider.
		//
		// Structural, because jsdom performs no layout and cannot be asked where
		// the line breaks. The property that MAKES it wrap correctly is that the
		// two are one flex child, and that IS observable: same parent, and that
		// parent is not the wrapping row itself.
		await renderRoute([guestRow()]);
		const card = within(cardTextColumn("Ada Guest"));
		const sep = card.getByText("·");
		const emailLink = card.getByRole("link", { name: "ada@example.com" });
		const phone = card.getByRole("link", { name: /\+14155552671/ });

		expect(
			sep.parentElement,
			"The separator must share a parent with the email anchor, or the flex " +
				"container can wrap between them and strand the '·' at the end of " +
				"the previous line.",
		).toBe(emailLink.parentElement);
		// …and that shared parent is a child of the wrapping row, not the row
		// itself — otherwise "same parent" is trivially true and pins nothing.
		expect(sep.parentElement).not.toBe(phone.parentElement);
	});

	it("renders no separator and no phone for a whitespace-only number", async () => {
		// `WhatsAppPhoneLink` trims and renders NOTHING for this value, so a gate
		// on the raw column would leave a "·" hanging in front of the email with
		// nothing to its left.
		await renderRoute([guestRow({ phone: "   " })]);
		const card = within(cardTextColumn("Ada Guest"));

		expect(card.queryByText("·")).toBeNull();
		expect(card.queryByRole("link", { name: /WhatsApp/i })).toBeNull();
		expect(card.getByRole("link", { name: "ada@example.com" })).toBeTruthy();
	});

	it("builds the mailto: from the trimmed email, not the raw column", async () => {
		// The gate tests the trimmed value, so the href has to be built from the
		// same string — otherwise a padded row ships `mailto: ada@example.com `.
		await renderRoute([guestRow({ email: "  ada@example.com  " })]);
		const card = within(cardTextColumn("Ada Guest"));

		expect(
			card.getByRole("link", { name: "ada@example.com" }).getAttribute("href"),
		).toBe("mailto:ada@example.com");
	});

	it("escapes a stored email so it cannot inject mailto headers", async () => {
		// Everything after the first `?` in a mailto URL is HEADERS the reader's
		// mail client honours, so a stored "a@b.com?bcc=…" interpolated raw makes
		// the VPM's own client blind-copy a third party on a message they believe
		// is private. `newGuestSchema` and `assignGuestSchema` now validate this
		// column as an email, but rows written before that persist — the write fix
		// stops new values, this stops the stored ones.
		const hostile = "ada@example.com?bcc=attacker@evil.com&subject=hi";
		await renderRoute([guestRow({ email: hostile })]);
		const card = within(cardTextColumn("Ada Guest"));
		const href =
			card.getByRole("link", { name: hostile }).getAttribute("href") ?? "";

		// Structural, not an exact-string match: the assertion is "no live
		// delimiter survives", which stays true under any correct escaping.
		expect(href.startsWith("mailto:")).toBe(true);
		expect(href.slice("mailto:".length)).not.toMatch(/[?&]/);
		// And it still parses as one recipient with an empty header section —
		// the property a partial escape would break.
		expect(new URL(href).search).toBe("");
		// The visible text is unchanged: escaping the href must not mangle what
		// the officer reads, which is how they notice the address is wrong.
		expect(card.getByRole("link", { name: hostile })).toBeTruthy();
	});

	it("renders no separator when the guest has a phone but no email", async () => {
		await renderRoute([guestRow({ email: null })]);
		const card = within(cardTextColumn("Ada Guest"));

		expect(card.queryByText("·")).toBeNull();
		expect(card.getByRole("link", { name: /\+14155552671/ })).toBeTruthy();
		expect(card.queryByRole("link", { name: /@/ })).toBeNull();
	});

	it("renders no contact line at all when the guest has neither", async () => {
		await renderRoute([guestRow({ email: null, phone: null })]);
		const column = cardTextColumn("Ada Guest");

		// Structural, not textual: the name line and the visits line, and nothing
		// between them. An empty contact <div> would still pass a "no · and no
		// link" assertion while shipping a stray empty row.
		expect(column.children.length).toBe(2);
		expect(within(column).queryByRole("link")).toBeNull();
		expect(within(column).queryByText("·")).toBeNull();
	});
});

/**
 * The guest edit dialog prefills the STORED phone, not the coalesced one.
 *
 * `loadGuestPipeline` carries the number twice — `phone` coalesced to E.164 for
 * the card's WhatsApp link, `phoneRaw` byte-for-byte for this form. Coalescing
 * is a country-code GUESS, so a guest stored as "415-555-2671 x12" displays as
 * "+1415555267112"; prefilling THAT shows the VPM a number nobody typed, in the
 * dialog they opened to fix a name.
 *
 * Both fields are plausible numbers on the same object, so only an assertion on
 * the VALUE separates the two bindings — hence a fixture where they differ.
 */
describe("VP Membership guest card — edit dialog phone prefill", () => {
	async function openEditDialog(): Promise<HTMLInputElement> {
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		return (await screen.findByLabelText("Phone")) as HTMLInputElement;
	}

	it("prefills the stored value, not the E.164 the card links to", async () => {
		await renderRoute([guestRow()]);

		// The card is read FIRST: the dialog is modal, so opening it `aria-hidden`s
		// the rest of the page. Asserting both in one test pins the SPLIT — display
		// coalesced, form raw — which a prefill-only assertion would not, since
		// reverting BOTH to the raw column would satisfy it.
		expect(
			within(cardTextColumn("Ada Guest"))
				.getByRole("link", { name: /\+14155552671/ })
				.getAttribute("href"),
		).toContain("14155552671");

		expect(
			(await openEditDialog()).value,
			"The guest edit dialog must prefill `guest.phoneRaw` (the stored " +
				"column), not `guest.phone` (coalesced for display) — see " +
				"PipelineGuestRow.phoneRaw.",
		).toBe("415-555-2671 x12");
	});

	it("prefills a digit-less stored value verbatim", async () => {
		// `toStoredPhone` preserves input it cannot normalize, and the guest
		// editor's phone field has no digit requirement — reachable in normal use.
		// Coalescing passes it through unchanged, so this case alone would pass on
		// either binding; it is here for the branch, paired with the one above.
		await renderRoute([
			guestRow({ phone: "call the office", phoneRaw: "call the office" }),
		]);
		expect((await openEditDialog()).value).toBe("call the office");
	});

	it("prefills empty for a guest with no number on file", async () => {
		await renderRoute([guestRow({ phone: null, phoneRaw: null })]);
		expect((await openEditDialog()).value).toBe("");
	});
});

describe("VP Membership guest card — undo a conversion (#618)", () => {
	const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

	/** A guest converted for real: pointer set, and NOT a link. */
	function convertedRow(over: Partial<PipelineGuestRow> = {}) {
		return guestRow({
			name: "Converted Guest",
			stage: "joined",
			convertedMembershipId: MEMBERSHIP,
			linkReversible: false,
			conversionUndoable: true,
			...over,
		});
	}

	it("offers Undo conversion on a real convert that carries a record", async () => {
		await renderRoute([convertedRow()]);
		expect(
			screen.getByRole("button", { name: /undo conversion/i }),
		).toBeTruthy();
	});

	it("offers nothing when the conversion predates the record", async () => {
		// The server would refuse this one, and a button that always fails is
		// worse than none — the same reasoning that keeps Unlink off a real
		// convert. Asserted as an ABSENCE because that is the actual invariant.
		await renderRoute([convertedRow({ conversionUndoable: false })]);
		expect(
			screen.queryByRole("button", { name: /undo conversion/i }),
		).toBeNull();
	});

	it("offers Unlink, not Undo, for a guest that was LINKED", async () => {
		await renderRoute([
			convertedRow({ linkReversible: true, conversionUndoable: false }),
		]);
		expect(screen.getByRole("button", { name: /unlink/i })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /undo conversion/i }),
		).toBeNull();
	});

	it("offers no Undo on a STRANDED guest, which has its own controls back", async () => {
		// Stranded = joined with a null pointer (#632). There is no membership
		// left to unwind, and the card already shows the stage buttons again.
		await renderRoute([
			convertedRow({ convertedMembershipId: null, conversionUndoable: false }),
		]);
		expect(
			screen.queryByRole("button", { name: /undo conversion/i }),
		).toBeNull();
	});
});

/**
 * The reactivation notice (#501).
 *
 * Convert reuses the person's existing membership in this club when there is
 * one, and it now WAKES that row when it had lapsed — `inactive` hides a
 * membership from the roster, the sign-up sheet, the season grid and every
 * picker, so the old behaviour produced a member nobody could see behind a
 * success toast saying it had worked. The wake-up is deliberately not silent:
 * Person dedup can match the wrong human (#561), and this line is the admin's
 * chance to notice.
 *
 * The gate is the FLAG → COPY seam, which is the only conditional logic the UI
 * half introduced. The copy is imported from `#/lib/guest-convert` rather than
 * retyped here, so a reworded constant cannot leave the assertion agreeing with
 * a sentence the app no longer ships. What this cannot see is sonner's own
 * rendering of `description` — the module is mocked, as every toast test in
 * this repo mocks it.
 */
describe("VP Membership guest card — reactivation notice (#501)", () => {
	function prospect() {
		return guestRow({ name: "Returning Guest", stage: "prospect" });
	}

	async function clickConvert(
		result: Partial<ConvertNotice> & { reactivated: boolean },
	) {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		vi.mocked(convertGuestToMember).mockResolvedValue({
			ok: true,
			membershipId: "44444444-4444-4444-8444-444444444444",
			personId: "55555555-5555-4555-8555-555555555555",
			closedOfficerPositions: [],
			...result,
			// biome-ignore lint/suspicious/noExplicitAny: the server fn's wrapped return type
		} as any);
		await renderRoute([prospect()]);
		fireEvent.click(screen.getByRole("button", { name: /convert/i }));
		await waitFor(() => expect(convertGuestToMember).toHaveBeenCalled());
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		return vi.mocked(toast.success).mock.calls.at(-1);
	}

	it("says a lapsed membership was reactivated, and names the prior status", async () => {
		const call = await clickConvert({ reactivated: true });

		expect(call?.[0]).toContain("Returning Guest");
		expect(call?.[1]).toEqual({ description: CONVERT_REACTIVATED_MESSAGE });
		// The prior status is the half that makes this worth showing: "we did
		// something" is not information, "this human was already on your roster
		// and had lapsed" is. Asserted on the constant's VALUE so a rewrite that
		// drops it fails here rather than passing on an identity comparison.
		expect(CONVERT_REACTIVATED_MESSAGE).toMatch(/inactive/i);
	});

	it("says nothing extra when convert did not reactivate anything", async () => {
		// The common path: a fresh membership, or reuse of one that was already
		// active. A notice here would cry wolf and admins would learn to ignore
		// it — so the ABSENCE is the invariant, not merely "some other text".
		const call = await clickConvert({ reactivated: false });

		expect(call?.[0]).toContain("Returning Guest");
		expect(call?.[1]).toBeUndefined();
	});

	it("says the club role was written back down, and where to undo that", async () => {
		// A SILENT demotion is its own bug. The admin is looking at a guest card
		// that shows no role at all, so unless the toast says so, the one thing
		// they cannot discover is that converting this guest changed somebody's
		// permissions — and they may have wanted that person back as an admin.
		const call = await clickConvert({
			reactivated: true,
			demotedFrom: "admin",
		});

		const description = (call?.[1] as { description: string }).description;
		expect(description).toContain(CONVERT_REACTIVATED_MESSAGE);
		expect(description).toContain(CONVERT_DEMOTED_MESSAGE);
		// The remedy, asserted on the VALUE: a notice that reports a demotion
		// without naming where to reverse it leaves the admin hunting.
		expect(CONVERT_DEMOTED_MESSAGE).toMatch(/member page/i);
	});

	it("names the officer term the wake-up ended, beside the demotion", async () => {
		// Two permission changes in one button press (#805): the stored role goes
		// down, and the open term that would have granted the same access through
		// effective-admin (#202) is ended with it. Both sentences, or the admin
		// is told less than the convert actually did to someone's standing.
		const call = await clickConvert({
			reactivated: true,
			demotedFrom: "admin",
			closedOfficerPositions: ["president"],
		});

		const description = (call?.[1] as { description: string }).description;
		expect(description).toContain(CONVERT_DEMOTED_MESSAGE);
		expect(description).toContain("President");
		expect(description).toMatch(/full club admin/i);
	});

	it("says a fresh member's email is already on another roster entry (#759)", async () => {
		// A FRESH membership — `reactivated: false` — which the notice used to be
		// structurally silent on. It is the only convert that writes an address.
		const call = await clickConvert({
			reactivated: false,
			rosterConflict: "shared_address",
		});

		expect(call?.[1]).toEqual({
			description: ROSTER_CONFLICT_COPY.shared_address,
		});
	});
});

/**
 * The invite-to-next-meeting control (#899). A draft plus a record of who
 * reached out — the app never sends. What is pinned here is the half no server
 * test can see: which rows get the control, the two disabled reasons and their
 * precedence, the history line, and that tapping a draft records exactly once
 * without stopping the draft from opening.
 */
describe("VP Membership guest card — invite to the next meeting (#899)", () => {
	// 2099 so the meeting is always in the future relative to the test clock.
	const NEXT_AT = new Date("2099-10-09T02:00:00Z"); // Thu Oct 8, 7pm in LA
	const withNext: NextMeetingSummary = {
		timezone: "America/Los_Angeles",
		nextMeeting: {
			id: "33333333-3333-4333-8333-333333333333",
			urlKey: "2099-10-08",
			scheduledAt: NEXT_AT,
			location: "Room 4",
		},
	};

	function inviteGroup(): HTMLElement {
		return screen.getByRole("group", { name: /^Invite/ });
	}

	it("renders for Prospects and Following up, not for Joined, Lost or a stranded guest", async () => {
		await renderRoute(
			[
				guestRow({ id: "a1111111-1111-4111-8111-111111111111", name: "P One" }),
				guestRow({
					id: "a2222222-2222-4222-8222-222222222222",
					name: "F Two",
					stage: "following_up",
				}),
				guestRow({
					id: "a3333333-3333-4333-8333-333333333333",
					name: "L Three",
					stage: "lost",
				}),
				// Stranded: joined with a null pointer (#618). It renders in Joined
				// and the server refuses it, so it gets no control.
				guestRow({
					id: "a4444444-4444-4444-8444-444444444444",
					name: "S Four",
					stage: "joined",
					convertedMembershipId: null,
				}),
			],
			withNext,
		);
		const groups = screen.getAllByRole("group", {
			name: "Invite to Thu, Oct 8",
		});
		expect(groups).toHaveLength(2);
		// Each belongs to an invitable row.
		for (const name of ["P One", "F Two"]) {
			const row = screen.getByText(name).closest("div.border-b");
			expect(
				within(row as HTMLElement).getByRole("group", { name: /^Invite/ }),
			).toBeTruthy();
		}
		for (const name of ["L Three", "S Four"]) {
			const row = screen.getByText(name).closest("div.border-b");
			expect(
				within(row as HTMLElement).queryByRole("group", { name: /^Invite/ }),
			).toBeNull();
		}
	});

	it("is disabled with 'Schedule the next meeting first' when there is none — even with no contact", async () => {
		// Both disabled reasons apply; the no-meeting reason wins.
		await renderRoute([guestRow({ phone: null, email: null })]);
		const group = inviteGroup();
		expect(group.getAttribute("aria-disabled")).toBe("true");
		expect(group.getAttribute("title")).toBe("Schedule the next meeting first");
		expect(
			within(group).getByText("Schedule the next meeting first"),
		).toBeTruthy();
		expect(within(group).queryAllByRole("link")).toHaveLength(0);
	});

	it("is disabled with 'Add an email or phone to invite' when the guest has no contact", async () => {
		await renderRoute([guestRow({ phone: "  ", email: null })], withNext);
		const group = inviteGroup();
		expect(group.getAttribute("aria-disabled")).toBe("true");
		expect(group.getAttribute("title")).toBe("Add an email or phone to invite");
		expect(
			within(group).getByText("Add an email or phone to invite"),
		).toBeTruthy();
		expect(within(group).queryAllByRole("link")).toHaveLength(0);
	});

	it("drafts to the public agenda and records the invite exactly once per tap", async () => {
		vi.mocked(recordGuestInvite).mockResolvedValue({ ok: true });
		await renderRoute([guestRow()], withNext);
		const group = inviteGroup();
		const email = await within(group).findByRole("link", { name: /email/i });
		const href = email.getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).toContain(
			"/club/downtown/meeting/2099-10-08",
		);
		expect(decodeURIComponent(href)).toContain("at Room 4");

		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		email.dispatchEvent(click);
		// The draft must still open: the handler does not prevent navigation.
		expect(click.defaultPrevented).toBe(false);
		expect(recordGuestInvite).toHaveBeenCalledTimes(1);
		expect(recordGuestInvite).toHaveBeenCalledWith({
			data: {
				clubId: "22222222-2222-4222-8222-222222222222",
				guestId: "11111111-1111-4111-8111-111111111111",
				meetingId: "33333333-3333-4333-8333-333333333333",
			},
		});

		vi.mocked(recordGuestInvite).mockClear();
		fireEvent.click(within(group).getByRole("link", { name: /whatsapp/i }));
		expect(recordGuestInvite).toHaveBeenCalledTimes(1);
	});

	it("shows the write-error toast when recording fails", async () => {
		vi.mocked(recordGuestInvite).mockRejectedValue(
			new Error("That meeting is cancelled."),
		);
		await renderRoute([guestRow()], withNext);
		fireEvent.click(
			await within(inviteGroup()).findByRole("link", { name: /email/i }),
		);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("That meeting is cancelled."),
		);
	});

	it("shows who invited them, and how many meetings", async () => {
		await renderRoute([
			guestRow({
				lastInvite: {
					meetingId: "33333333-3333-4333-8333-333333333333",
					meetingAt: NEXT_AT,
					invitedByName: "Sam Officer",
				},
				inviteCount: 3,
			}),
		]);
		expect(
			screen.getByText(
				"Invited to Thu, Oct 8 · by Sam Officer · invited to 3 meetings",
			),
		).toBeTruthy();
	});

	it("omits 'by' for a null inviter, the count for one meeting, and says 'Last' once it has passed", async () => {
		await renderRoute([
			guestRow({
				lastInvite: {
					meetingId: "33333333-3333-4333-8333-333333333333",
					meetingAt: new Date("2026-01-09T03:00:00Z"), // Thu Jan 8 in LA
					invitedByName: null,
				},
				inviteCount: 1,
			}),
		]);
		expect(screen.getByText("Last invited to Thu, Jan 8")).toBeTruthy();
	});
});
