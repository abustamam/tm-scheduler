// Pure, client-safe phone normalization to E.164 (#295). The tap-to-nudge
// WhatsApp channel (#37) needs a full international number (country code, no
// spaces) — `wa.me` rejects a bare national number. Stored phone is free text,
// so this coalesces it to E.164 at read time, using a club's default country
// code for numbers that lack one.
//
// This is BEST-EFFORT, not libphonenumber: a stored national number that
// embeds a country code without a leading `+` can't be told apart from a plain
// national number, so a default is prepended to anything not already
// `+`/`00`-prefixed. The durable fix is standardizing phone INPUTS to E.164 on
// write (the deferred part of #295); until then, a club default country code
// makes existing free-text numbers reliable for WhatsApp.
//
// E.164 is also the DEDUP KEY for guests and people (#397): two spellings of one
// number must produce one key. That only works if the promotion below ALWAYS
// applies — see `DEFAULT_COUNTRY_CODE`.

/**
 * The country code assumed when a club hasn't set one (#397).
 *
 * Without a default, `toE164` returns null for a bare national number, so
 * `toStoredPhone` stores it as typed — and then `(555) 123-4567` and
 * `+1 (555) 123-4567` are two different dedup keys for one phone. Every spelling
 * has to converge, and the only way to compare a country-code-less number is to
 * assume a country: comparing "the last 10 digits" instead would silently equate
 * numbers that genuinely differ across country codes.
 *
 * `+1` mirrors the `America/Chicago` default on `clubs.timezone` — the app's
 * standing assumption for a club that hasn't told us otherwise. A club outside
 * NANP sets its own code on /admin/club-settings, which wins everywhere (see
 * `loadClubDefaultCountryCode`); this is only the fallback.
 */
export const DEFAULT_COUNTRY_CODE = "+1";

/** Digits of a country code, e.g. "+1" | "1" → "1"; empty/invalid → "". */
function ccDigits(cc: string | null | undefined): string {
	return (cc ?? "").replace(/\D/g, "");
}

/**
 * Strip the DOMESTIC dialing prefix from a national-format number, so the
 * country code can be prepended without duplicating it.
 *
 * - NANP (`+1`): the long-distance prefix is `1`, and NANP national numbers are
 *   exactly 10 digits — so 11 digits starting with `1` is `1` + the number
 *   ("1 (555) 123-4567"), never an 11-digit national number. Without this,
 *   "1 555 123 4567" would store as `+115551234567` and miss dedup against the
 *   same number typed the other ways (#397). A 10-digit number starting with 1
 *   is untouched: NANP area codes never start with 0 or 1.
 * - Elsewhere: a single leading trunk `0` (the UK/EU "020…" → "+44 20…").
 */
function toNationalDigits(digits: string, cc: string): string {
	if (cc === "1") {
		return digits.length === 11 && digits.startsWith("1")
			? digits.slice(1)
			: digits;
	}
	return digits.replace(/^0/, "");
}

/**
 * Repair an already-international number that carries NANP's domestic `1` on
 * top of the `+1` country code (#397).
 *
 * `+1` + `1 (555) 123-4567` was the pre-fix output for a pasted "1 555…" in a
 * club with a country code set, so those rows are already in the database. They
 * pass through the `+…` branch untouched, which would leave them permanently
 * unmatchable against the same number typed any other way — the dedup bug, one
 * level down, for the rows the backfill was supposed to rescue.
 *
 * 12 digits beginning `11` can only be that: country code 1 is the ONLY code
 * beginning with 1, NANP subscriber numbers are exactly 10 digits (so 11 total),
 * and NANP area codes never start with 1. There is no valid number this
 * misidentifies.
 */
function repairIntlDigits(digits: string): string {
	return digits.length === 12 && digits.startsWith("11")
		? `1${digits.slice(2)}`
		: digits;
}

/**
 * Normalize a free-text phone to E.164 (`+<digits>`), or null when it can't be
 * made reliable.
 *
 * - `+…` or `00…` (international prefix) → taken as-is (formatting stripped).
 * - otherwise, if `defaultCountryCode` is set → that code is prepended.
 * - otherwise → null (a bare national number has no reliable country code).
 * - empty / no digits → null.
 */
export function toE164(
	raw: string | null | undefined,
	defaultCountryCode?: string | null,
): string | null {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") return null;

	if (trimmed.startsWith("+")) {
		const digits = trimmed.replace(/\D/g, "");
		return digits === "" ? null : `+${repairIntlDigits(digits)}`;
	}

	const digits = trimmed.replace(/\D/g, "");
	if (digits === "") return null;

	// `00` international access prefix → the rest is the international number.
	if (digits.startsWith("00")) {
		const intl = digits.slice(2);
		return intl === "" ? null : `+${repairIntlDigits(intl)}`;
	}

	const cc = ccDigits(defaultCountryCode);
	if (cc === "") return null; // no country code, no default → not reliable

	return `+${cc}${toNationalDigits(digits, cc)}`;
}

/**
 * Normalize a stored phone for READING: E.164 when it can be derived, otherwise
 * the value exactly as stored. The read-side mirror of `toStoredPhone`, and the
 * one form every payload that renders a phone should use. Unlike `toStoredPhone`
 * it does not trim or collapse: the stored value comes back byte-for-byte, so
 * `""` stays `""` — which is what the inline call sites it replaces already did.
 * The trailing `?? null` only normalizes `undefined`.
 *
 * The `?? raw` half is load-bearing, and it lives here so it is discoverable from
 * `toE164` rather than rediscovered at each call site. `toE164` returns null for
 * anything with no digits ("call the office"), and `toStoredPhone` DELIBERATELY
 * stores such input verbatim so the member can still see and edit it — and the
 * roster/guest editors validate phone as a plain nullable string with no digit
 * requirement, so it is reachable in normal use, not just in legacy data. A read
 * path using bare `toE164` therefore erases a number the user can currently read,
 * and starves `WhatsAppPhoneLink`'s plain-text branch, which exists to render
 * exactly that case as text rather than a dead link.
 */
export function coalesceToE164(
	raw: string | null | undefined,
	defaultCountryCode?: string | null,
): string | null {
	return toE164(raw, defaultCountryCode) ?? raw ?? null;
}

/**
 * Normalize a phone for STORAGE on write (#295): E.164 (`+…`) when it can be
 * derived (already international, or a national number plus the club's default
 * country code), otherwise the trimmed raw input so a number we can't fully
 * normalize is preserved rather than dropped (read-time `toE164` coalescing can
 * still reach it later, and the user can see/edit it). `null` only for
 * empty/contentless input.
 */
export function toStoredPhone(
	raw: string | null | undefined,
	defaultCountryCode?: string | null,
): string | null {
	return toE164(raw, defaultCountryCode) ?? ((raw ?? "").trim() || null);
}
