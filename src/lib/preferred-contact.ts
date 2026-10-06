/**
 * A member's preferred contact method (#1093): which ones a Person can have,
 * and what a stored choice MEANS once their data has changed.
 *
 * Pure and client-safe on purpose: the server's two writers, every reader, and
 * the forms that offer the choices all ask these questions, and a helper living
 * in a `-logic.ts` module (which imports `#/db`) would be unreachable from the
 * client, which would then grow a second copy (CODING_STANDARDS.md, "Data
 * layer"). The SQL half of `availableContactMethods`, used in the writers'
 * UPDATE, is `contactMethodAvailableSql` in `contact-preference-logic.ts`.
 *
 * **A stale value is kept, not cleared.** A member who chose SMS and then lost
 * their phone keeps `sms` in the column; every reader shows no preference until
 * a phone is back. So nothing may read `people.preferred_contact` raw: it goes
 * through `effectivePreferredContact`.
 */

export const CONTACT_METHODS = ["email", "call", "sms", "whatsapp"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

/** The methods that need a phone. All three use the same "has a digit" test. */
export const PHONE_CONTACT_METHODS: readonly ContactMethod[] = [
	"call",
	"sms",
	"whatsapp",
];

/** What the forms and the roster icon's `aria-label` call each method. */
export const CONTACT_METHOD_LABELS: Record<ContactMethod, string> = {
	email: "Email",
	call: "Call",
	sms: "SMS",
	whatsapp: "WhatsApp",
};

/** Both writers' refusal of a method whose data is missing. */
export const CONTACT_METHOD_UNAVAILABLE_MESSAGE =
	"Add a phone number or email first.";

/**
 * The admin edit's refusal for a Person who has signed in: once a member has an
 * account, the choice is theirs. The WHOLE edit is refused, not just the field.
 */
export const CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE =
	"This member sets their own contact preference.";

/**
 * Does this stored phone have anything to dial?
 *
 * At least one digit. Deliberately not a truthiness check: a digit-less value
 * ("ask at church") is kept verbatim by `coalesceToE164` and rendered by
 * `WhatsAppPhoneLink` as plain text, and `whatsappHref` returns null for it.
 * The roster cell's `pointer-events` keys off this, and so does whether Call,
 * SMS and WhatsApp are available. One copy, so the two cannot disagree.
 */
export function hasDialablePhone(phone: string | null | undefined): boolean {
	return /\d/.test(phone ?? "");
}

function hasEmail(email: string | null | undefined): boolean {
	return Boolean(email?.trim());
}

/** The methods this Person's current email and phone support, in display order. */
export function availableContactMethods(p: {
	email: string | null;
	phone: string | null;
}): ContactMethod[] {
	return CONTACT_METHODS.filter((m) =>
		m === "email" ? hasEmail(p.email) : hasDialablePhone(p.phone),
	);
}

/**
 * The preference every surface shows: `stored` while its data exists,
 * otherwise null ("no preference"). The column itself is never cleared.
 */
export function effectivePreferredContact(
	stored: ContactMethod | null,
	p: { email: string | null; phone: string | null },
): ContactMethod | null {
	if (stored === null) return null;
	return availableContactMethods(p).includes(stored) ? stored : null;
}

/** Narrow an untyped value to a method, or null. For form fields. */
export function parseContactMethod(value: unknown): ContactMethod | null {
	return typeof value === "string" &&
		(CONTACT_METHODS as readonly string[]).includes(value)
		? (value as ContactMethod)
		: null;
}

/**
 * What the member edit form sends for the preference (#1093). Like the phone
 * (`phoneEditPayload`, #906), the key is sent only when the officer changed
 * the field, so a stale page cannot write back a value the member has since
 * changed. `field` is the select's value ("" = no preference); `loaded` is the
 * effective value it was prefilled with.
 */
export function preferredContactEditPayload(
	field: string,
	loaded: ContactMethod | null,
): { preferredContact?: ContactMethod | null } {
	const next = parseContactMethod(field);
	if (next === loaded) return {};
	return { preferredContact: next };
}

/**
 * The phone as a `tel:`/`sms:` target: a leading `+` and the digits, nothing
 * else, so no other character of the stored value (a `?body=`, a note) reaches
 * the URI. Null when there is nothing to dial.
 */
function dialTarget(phone: string | null | undefined): string | null {
	const trimmed = (phone ?? "").trim();
	const digits = trimmed.replace(/\D/g, "");
	if (!digits) return null;
	return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** `tel:` link for a stored phone, or null with no digit in it. */
export function telHref(phone: string | null | undefined): string | null {
	const target = dialTarget(phone);
	return target ? `tel:${target}` : null;
}

/** `sms:` link, no body, for a stored phone, or null with no digit in it. */
export function smsHref(phone: string | null | undefined): string | null {
	const target = dialTarget(phone);
	return target ? `sms:${target}` : null;
}
