// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { shellPropsFromContext } from "./app-shell";

// `app-shell.tsx` transitively imports server fns (ClubSwitcher → auth-context,
// GlobalSearch → members) that pull in `#/db`, which throws at import when
// DATABASE_URL is unset. `shellPropsFromContext` is pure and never touches it —
// stub the module so the import chain resolves.
vi.mock("#/db", () => ({ db: {} }));

/**
 * `shellPropsFromContext` is the single source of the shell's display props,
 * shared by `_authed.tsx` and the public shell-wrappers (#317). These pin the
 * derivation (club name/number, effective-admin, role label, initials, search
 * grants) so the two shells can't drift. Pure over a ctx object.
 */
const baseCtx = () => ({
	user: { id: "u1", name: "Ada Byron", email: "ada@x.test" },
	clubs: [
		{
			clubId: "cA",
			name: "Alpha Club",
			clubNumber: "12345",
			clubRole: "member" as const,
		},
	],
	currentMemberId: "mA",
	activeClubId: "cA",
	officerPositions: [] as const,
	isSuperadmin: false,
	impersonating: null,
});

describe("shellPropsFromContext", () => {
	it("derives display props for a plain member of the active club", () => {
		const p = shellPropsFromContext(baseCtx());
		expect(p.clubName).toBe("Alpha Club");
		expect(p.clubNumber).toBe("12345");
		expect(p.isOfficer).toBe(false);
		expect(p.hasOffice).toBe(false);
		expect(p.roleLabel).toBe("Member");
		expect(p.displayName).toBe("Ada Byron");
		expect(p.initials).toBe("AB");
		expect(p.searchGrants).toEqual({
			hasOffice: false,
			isOfficer: false,
			isSuperadmin: false,
		});
	});

	it("labels an officer by their highest office and grants officer nav", () => {
		const p = shellPropsFromContext({
			...baseCtx(),
			officerPositions: ["vp_education", "president"] as const,
		});
		expect(p.hasOffice).toBe(true);
		expect(p.isOfficer).toBe(true);
		// president outranks vp_education in the canonical order.
		expect(p.roleLabel).toBe("President");
		expect(p.searchGrants).toEqual({
			hasOffice: true,
			isOfficer: true,
			isSuperadmin: false,
		});
	});

	it("treats a stored admin as an officer even with no elected office", () => {
		const p = shellPropsFromContext({
			...baseCtx(),
			clubs: [
				{
					clubId: "cA",
					name: "Alpha Club",
					clubNumber: null,
					clubRole: "admin" as const,
				},
			],
		});
		expect(p.hasOffice).toBe(false);
		expect(p.isOfficer).toBe(true);
		expect(p.roleLabel).toBe("Officer");
		expect(p.clubNumber).toBeNull();
	});

	it("falls back to the email when the user has no name", () => {
		const p = shellPropsFromContext({
			...baseCtx(),
			user: { id: "u1", name: "", email: "solo@x.test" },
		});
		expect(p.displayName).toBe("solo@x.test");
	});

	it("throws when called without a signed-in user", () => {
		expect(() => shellPropsFromContext({ ...baseCtx(), user: null })).toThrow();
	});
});
