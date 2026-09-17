/**
 * THE serializer every guest passes through on its way out of the MCP layer
 * (#773, design D9).
 *
 * Tool results are transcribed into an LLM provider's conversation history, so
 * a guest's real email and phone would leave the app the moment any tool named
 * them. Masked is enough for the job these tools do: confirming that the "Jane
 * D." on a handwritten page is the `j•••@gmail.com` already on file. The full
 * values stay in the database, and MATCHING runs on them server-side — the
 * caller never needs to compare contact details itself, which is exactly why
 * masking costs nothing here.
 *
 * **One serializer, not a rule each tool remembers.** A convention that every
 * tool must mask is one forgetful diff away from leaking, and this repo has
 * shipped that shape before (#37, #637: a reader passed straight through and
 * widened PII on a page as a side effect of a bug fix). So tools call the
 * existing readers and then this, and a test asserts no tool result anywhere
 * contains a raw email address.
 *
 * Member contact is not returned by any tool at all, so it needs no masking
 * function — there is nothing to mask.
 */

/** A guest as the MCP tools present it. No unmasked contact field exists here. */
export interface McpGuest {
	id: string;
	kind: "guest";
	name: string;
	preferredName: string | null;
	/** `j•••@gmail.com`, or null when the guest has no email on file. */
	emailMasked: string | null;
	/** `•••-4567`, or null when the guest has no phone on file. */
	phoneMasked: string | null;
}

/**
 * `jane.doe@gmail.com` → `j•••@gmail.com`.
 *
 * Keeps the first character and the whole domain: enough to recognise an
 * address you already know, not enough to write to it. A single-character local
 * part masks to `j•••@…` like any other rather than exposing that it was short.
 */
export function maskEmail(email: string | null | undefined): string | null {
	const value = email?.trim();
	if (!value) return null;
	const at = value.lastIndexOf("@");
	// No `@` at all is not an address; mask the whole thing rather than guessing.
	if (at <= 0) return "•••";
	return `${value[0]}•••${value.slice(at)}`;
}

/**
 * `+15551234567` → `•••-4567`.
 *
 * The last four digits are the part a human uses to confirm a number, and alone
 * they identify nobody. Anything with fewer than four digits masks entirely.
 */
export function maskPhone(phone: string | null | undefined): string | null {
	const digits = (phone ?? "").replace(/\D/g, "");
	if (!digits) return null;
	if (digits.length < 4) return "•••";
	return `•••-${digits.slice(-4)}`;
}

/** The one conversion from a stored guest row to what a tool may return. */
export function toMcpGuest(row: {
	id: string;
	name: string;
	preferredName?: string | null;
	email?: string | null;
	phone?: string | null;
}): McpGuest {
	return {
		id: row.id,
		kind: "guest",
		name: row.name,
		preferredName: row.preferredName ?? null,
		emailMasked: maskEmail(row.email),
		phoneMasked: maskPhone(row.phone),
	};
}

/** A roster member as the MCP tools present it — name and identity only. */
export interface McpMember {
	id: string;
	kind: "member";
	name: string;
	preferredName: string | null;
}

export function toMcpMember(row: {
	id: string;
	name: string;
	preferredName?: string | null;
}): McpMember {
	return {
		id: row.id,
		kind: "member",
		name: row.name,
		preferredName: row.preferredName ?? null,
	};
}

export type McpPerson = McpGuest | McpMember;
