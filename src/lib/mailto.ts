// Pure, client-safe `mailto:` URL construction. One copy of the escaping rule,
// for the same reason `whatsapp.ts` holds one copy of the #485 desktop/mobile
// rule: there are three surfaces rendering a stored address as a link (the
// sign-up sheet's Contact column, the member profile header, the VP-Membership
// guest card), and an escaping rule with three copies has three chances to be
// the one that gets forgotten.

/**
 * A `mailto:` href for a stored address.
 *
 * ## What this is defending against
 *
 * Everything after the first `?` in a mailto URL is HEADERS — `subject`, `cc`,
 * `bcc`, `body` — which the user's mail client honours. So an address stored as
 * `a@b.com?bcc=attacker@evil.com` interpolated raw produces a link that silently
 * blind-copies a third party on a message the sender believes is private, and
 * `&body=…` puts words in their mouth. Not every writer of these columns has
 * always validated the value as an email (`guests.email` had two free-text
 * writers until this change; `members.email` still has one in
 * `bulkImportSchema`), and rows written before a validator was added persist
 * regardless. The write-side fix and this read-side fix are both needed: one
 * stops new values, the other neutralises the ones already stored.
 *
 * ## Why not bare `encodeURIComponent`
 *
 * It escapes `@` to `%40`, which every mail client decodes correctly but which
 * is not the canonical addr-spec form (RFC 6068 admits `@` unescaped) — so every
 * link in the app would read `mailto:ada%40example.com` in the status bar and on
 * copy-link, for no security gain. `@` cannot begin the header section; only `?`
 * can. So this encodes exactly what `encodeURIComponent` does and then restores
 * `@` alone, which closes the injection without making 100% of addresses uglier
 * to protect against 0% of them.
 *
 * Restoring anything else would be a bug: `?`, `&`, `#`, whitespace and `,`
 * (multiple recipients) all stay escaped.
 */
export function mailtoHref(email: string): string {
	return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
}
