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

/** Digits of a country code, e.g. "+1" | "1" → "1"; empty/invalid → "". */
function ccDigits(cc: string | null | undefined): string {
	return (cc ?? "").replace(/\D/g, "");
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
		return digits === "" ? null : `+${digits}`;
	}

	const digits = trimmed.replace(/\D/g, "");
	if (digits === "") return null;

	// `00` international access prefix → the rest is the international number.
	if (digits.startsWith("00")) {
		const intl = digits.slice(2);
		return intl === "" ? null : `+${intl}`;
	}

	const cc = ccDigits(defaultCountryCode);
	if (cc === "") return null; // no country code, no default → not reliable

	// Drop a single national trunk `0` before prepending the country code
	// (common in the UK/EU: "020…" nationally is "+44 20…").
	const national = digits.replace(/^0/, "");
	return `+${cc}${national}`;
}
