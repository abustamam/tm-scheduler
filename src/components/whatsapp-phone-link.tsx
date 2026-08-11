import { MessageCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { detectPlatform } from "#/lib/platform";
import { cn } from "#/lib/utils";
import { whatsappHref } from "#/lib/whatsapp";

/**
 * A rendered phone number that opens a WhatsApp conversation.
 *
 * WhatsApp, not `tel:`: nobody reaches for the dialer from a roster screen, and
 * someone who wants to call can copy the number into their own phone app. The
 * chat opens BLANK — these surfaces carry no role or meeting context, and the
 * context-aware drafts belong to `NudgeButtons` (#37).
 */
export function WhatsAppPhoneLink({
	phone,
	name,
	fallback = null,
	className,
}: {
	/** Free text, but callers pass server-normalized E.164 (see the spec). */
	phone: string | null | undefined;
	/** Whose number this is — carried in both the link's accessible name and its
	 *  title, so the destination is unambiguous before the tap. */
	name: string;
	/** Rendered when there is no number at all. */
	fallback?: ReactNode;
	/**
	 * Styling for the LINK only — it is merged onto the anchor and applies to
	 * neither the `fallback` (the caller renders that node itself) nor the
	 * digit-less text branch (see below). Callers pass colour; the base owns
	 * layout and `hover:underline`.
	 */
	className?: string;
}) {
	// Detection is deferred to the post-mount render — but NOT because `navigator`
	// is missing on the server. Node 21+ ships a global one, so on `node:22-slim`
	// `detectPlatform(navigator)` returns "desktop" (UA `Node.js/24`) rather than
	// throwing. That is precisely the hazard: unguarded, the server would emit
	// `web.whatsapp.com` while a phone's first client render emits `wa.me`, and the
	// two disagree on an attribute React has to reconcile. This guard makes the
	// server pass and EVERY first client render agree on "mobile" (the historical
	// `wa.me` default); the effect then re-renders with the platform-correct URL
	// (#485). Anyone who checks the old "navigator doesn't exist" claim, finds that
	// it does, and deletes the guard ships exactly that mismatch.
	//
	// Deliberately NOT `NudgeButtons`' `if (!mounted) return null`. That guard
	// exists there only because its `shareUrl` depends on `window.location.origin`;
	// borrowing it here would blank the number and shift layout on every row.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const platform = mounted ? detectPlatform(navigator) : "mobile";

	const trimmed = (phone ?? "").trim();
	if (trimmed === "") return <>{fallback}</>;

	const href = whatsappHref(trimmed, platform);
	// A stored value with no digits ("ask at church") can't open a chat. Show it
	// as text rather than swallowing it — the reader can still act on it.
	//
	// Deliberately WITHOUT `className`. Every call site passes an affordance class
	// for the anchor (`season-grid.tsx` passes `text-primary`, `members.$id.tsx` a
	// hover colour), and forwarding one here paints a plain string in link colour
	// with nothing to click. Owned by the component rather than by the four call
	// sites, none of which can know which branch will render. The text then
	// inherits the surrounding cell's colour, which is what it is: prose.
	if (!href) return <span>{trimmed}</span>;

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			title={`Message ${name} on WhatsApp`}
			// `hover:underline` belongs to the base rather than each call site: the
			// rest of the base is pure layout, so without it an anchor is visually
			// indistinguishable from the plain text beside it. Callers pass color.
			className={cn(
				"inline-flex items-center gap-1.5 hover:underline",
				className,
			)}
		>
			<MessageCircle className="size-3.5 shrink-0" aria-hidden />
			{trimmed}
			{/* `title` supplies only the accessible DESCRIPTION — per the accname
			    spec, content wins for the NAME and `title` is the last-resort source —
			    and screen readers announce descriptions inconsistently or not at all.
			    Without this the link announces as a bare string of digits, telling a
			    screen-reader user neither that it opens WhatsApp nor that it leaves
			    the page. The icon stays `aria-hidden`: the number is the name. */}
			<span className="sr-only">
				— message {name} on WhatsApp, opens in a new tab
			</span>
		</a>
	);
}
