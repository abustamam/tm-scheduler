/**
 * The pure half of #1050: the input schema, the home-club rule, the caption,
 * and the per-member "brought" tally. The database half is
 * `src/server/guest-profile.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { guestKindEnum } from "#/db/schema";
import {
	guestBookSchema,
	updateGuestProfileSchema,
} from "#/server/guest-pipeline-schemas";
import {
	countBroughtByMember,
	GUEST_KIND_LABELS,
	GUEST_KINDS,
	GUEST_TEXT_MAX,
	guestKindCaption,
	HOME_CLUB_TOO_LONG_MESSAGE,
	normalizeHomeClub,
	profileFieldsChanged,
} from "./guest-profile";

describe("GUEST_KINDS", () => {
	it("is exactly the database enum's values, in order", () => {
		expect([...GUEST_KINDS]).toEqual(guestKindEnum.enumValues);
	});

	// protects=the two kinds a guest can have, and the labels every select and
	// caption reads them by: the stored value `visitor` reads "Guest" (#1208);
	// fails_when=`guest_speaker` is selectable again, or `visitor` reads "Visitor";
	// no_claim=the labels' placement in the dialog and import preview, which their
	// own component tests cover.
	it("is two kinds, and the stored visitor value reads 'Guest'", () => {
		expect([...GUEST_KINDS]).toEqual(["visitor", "visiting_toastmaster"]);
		expect(GUEST_KIND_LABELS).toEqual({
			visitor: "Guest",
			visiting_toastmaster: "Visiting Toastmaster",
		});
	});
});

describe("updateGuestProfileSchema", () => {
	const base = { clubId: randomUUID(), guestId: randomUUID() };

	// protects=a tab opened before #1208 still saves: it sends the retired
	// `guest_speaker`, which the schema reads as `visiting_toastmaster` (input
	// alias, one release), so the save is stored as the kind the row was folded to;
	// fails_when=the schema refuses `guest_speaker` (an open tab's save would fail
	// across the deploy), or lets the old value through unmapped (it would then 500
	// at the database, which no longer has it), or starts accepting any string;
	// no_claim=the database's own refusal of `guest_speaker`, which the
	// integration test covers; the alias is input-only, nothing reads it back.
	it("reads the retired guest_speaker as visiting_toastmaster, and still refuses an unknown kind", () => {
		const parsed = updateGuestProfileSchema.parse({
			...base,
			kind: "guest_speaker",
			homeClub: "Laguna Speakers",
			introducedByMemberId: null,
		});
		expect(parsed.kind).toBe("visiting_toastmaster");
		expect(parsed.homeClub).toBe("Laguna Speakers");
		expect(
			updateGuestProfileSchema.safeParse({
				...base,
				kind: "member",
				homeClub: null,
				introducedByMemberId: null,
			}).success,
		).toBe(false);
	});

	it("accepts all three fields, trimming the home club", () => {
		const introducer = randomUUID();
		expect(
			updateGuestProfileSchema.parse({
				...base,
				kind: "visiting_toastmaster",
				homeClub: "  Laguna Speakers  ",
				introducedByMemberId: introducer,
			}),
		).toEqual({
			...base,
			kind: "visiting_toastmaster",
			homeClub: "Laguna Speakers",
			introducedByMemberId: introducer,
		});
	});

	it("caps the home club at the guest text cap, after trimming", () => {
		expect(GUEST_TEXT_MAX).toBe(120);
		expect(
			updateGuestProfileSchema.parse({
				...base,
				kind: "visiting_toastmaster",
				homeClub: `${"x".repeat(120)}    `,
			}).homeClub,
		).toHaveLength(120);
		expect(() =>
			updateGuestProfileSchema.parse({
				...base,
				kind: "visiting_toastmaster",
				homeClub: "x".repeat(121),
			}),
		).toThrow(HOME_CLUB_TOO_LONG_MESSAGE);
	});

	it("does NOT refuse an over-long home club on a Visitor — it is about to be cleared", () => {
		const parsed = updateGuestProfileSchema.parse({
			...base,
			kind: "visitor",
			homeClub: "x".repeat(500),
		});
		expect(parsed.kind).toBe("visitor");
	});

	it("shares its cap with the guest-book name", () => {
		expect(() =>
			guestBookSchema.parse({ clubId: base.clubId, name: "x".repeat(121) }),
		).toThrow(/too long/i);
	});

	it("refuses an unknown kind, a malformed introducer, and an unknown key", () => {
		expect(() =>
			updateGuestProfileSchema.parse({ ...base, kind: "member" }),
		).toThrow();
		expect(() =>
			updateGuestProfileSchema.parse({
				...base,
				kind: "visitor",
				introducedByMemberId: "not-a-uuid",
			}),
		).toThrow();
		expect(() =>
			updateGuestProfileSchema.parse({
				...base,
				kind: "visitor",
				actorMemberId: randomUUID(),
			}),
		).toThrow();
	});
});

describe("normalizeHomeClub", () => {
	it("clears it for a Visitor", () => {
		expect(normalizeHomeClub("visitor", "Downtown Speakers")).toBeNull();
	});

	it("trims it, and a blank one is null", () => {
		expect(normalizeHomeClub("visiting_toastmaster", "  Downtown  ")).toBe(
			"Downtown",
		);
		expect(normalizeHomeClub("visiting_toastmaster", "   ")).toBeNull();
		expect(normalizeHomeClub("visiting_toastmaster", null)).toBeNull();
	});
});

describe("guestKindCaption", () => {
	it("reads 'Visiting Toastmaster, <home club>'", () => {
		expect(guestKindCaption("visiting_toastmaster", "Laguna Speakers")).toBe(
			"Visiting Toastmaster, Laguna Speakers",
		);
	});

	it("names the kind alone when no home club is recorded", () => {
		expect(guestKindCaption("visiting_toastmaster", "  ")).toBe(
			"Visiting Toastmaster",
		);
	});

	it("is null for a Visitor, whatever is stored", () => {
		expect(guestKindCaption("visitor", "Leftover Club")).toBeNull();
	});
});

describe("countBroughtByMember", () => {
	it("counts per member, most first, then by name", () => {
		expect(
			countBroughtByMember([
				{ guestId: "g1", introducedByMemberId: "b", introducedByName: "Bea" },
				{ guestId: "g2", introducedByMemberId: "a", introducedByName: "Al" },
				{ guestId: "g3", introducedByMemberId: "b", introducedByName: "Bea" },
				{ guestId: "g4", introducedByMemberId: "c", introducedByName: "Cy" },
				{ guestId: "g5", introducedByMemberId: null, introducedByName: null },
			]),
		).toEqual([
			{ memberId: "b", name: "Bea", count: 2 },
			{ memberId: "a", name: "Al", count: 1 },
			{ memberId: "c", name: "Cy", count: 1 },
		]);
	});

	it("skips an introducer who resolved to no name", () => {
		expect(
			countBroughtByMember([
				{ guestId: "g1", introducedByMemberId: "x", introducedByName: null },
			]),
		).toEqual([]);
	});
});

describe("profileFieldsChanged", () => {
	const loaded = {
		kind: "visiting_toastmaster" as const,
		homeClub: "Laguna",
		introducedByMemberId: "m1",
	};

	it("is false when nothing changed, including whitespace-only home club edits", () => {
		expect(profileFieldsChanged(loaded, { ...loaded })).toBe(false);
		expect(
			profileFieldsChanged(loaded, { ...loaded, homeClub: "  Laguna " }),
		).toBe(false);
		expect(
			profileFieldsChanged(
				{ kind: "visitor", homeClub: null, introducedByMemberId: null },
				{ kind: "visitor", homeClub: null, introducedByMemberId: null },
			),
		).toBe(false);
	});

	it("is true when any one of the three changed", () => {
		expect(profileFieldsChanged(loaded, { ...loaded, kind: "visitor" })).toBe(
			true,
		);
		expect(profileFieldsChanged(loaded, { ...loaded, homeClub: "Other" })).toBe(
			true,
		);
		expect(
			profileFieldsChanged(loaded, { ...loaded, introducedByMemberId: null }),
		).toBe(true);
	});
});
