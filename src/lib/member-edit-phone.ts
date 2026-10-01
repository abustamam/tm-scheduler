/**
 * What the member edit form sends for the phone (#906 review).
 *
 * A phone number is a Person fact, shared by every club that holds them, and
 * `applyMemberEdit` treats an OMITTED phone as "leave the Person's alone". So
 * the form sends the key only when the officer actually changed the field. A
 * name-only save from a page loaded before another club corrected the number
 * must not write the stale prefill back over it for every club — nor re-run
 * `toStoredPhone` on it with this club's country code.
 *
 * `loaded` is the value the field was prefilled with (`phoneRaw`, byte-exact),
 * compared untrimmed so an untouched field is always "unchanged". A changed
 * field that is blank sends an explicit `null`, which clears.
 */
export function phoneEditPayload(
	field: string,
	loaded: string | null,
): { phone?: string | null } {
	if (field === (loaded ?? "")) return {};
	return { phone: field.trim() || null };
}
