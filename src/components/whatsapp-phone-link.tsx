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
	 * digit-less text branch (see below).
	 *
	 * The base owns layout, `hover:underline` AND colour, so a caller normally
	 * passes nothing. Colour is deliberately not a call-site concern: the anchor
	 * carries `data-slot="wa-phone"` to escape the unlayered `a { color }` rule in
	 * `styles.css`, and that escape has to travel with the colour that replaces
	 * it. A caller can still override a base utility (`cn` merges last-wins), but
	 * a colour passed here is a smell — put it in the base.
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
	// Deliberately WITHOUT `className`, and deliberately without the base's own
	// `text-primary`: forwarding link styling here paints a plain string in link
	// colour with nothing to click, an affordance that lies. This is why the
	// colour decision belongs to the component and not to the call sites — none of
	// them can know which of the three branches will render. The text inherits the
	// surrounding cell's colour, which is what it is: prose.
	if (!href) return <span>{trimmed}</span>;

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			title={`Message ${name} on WhatsApp`}
			// Opts this anchor OUT of the unlayered `a { color: … }` rule in
			// `styles.css`. That rule is unlayered, so it beats anything Tailwind
			// emits into `@layer utilities` — a `text-primary` here or at a call site
			// loses to it silently and the link renders `--lagoon-deep` (#328f97,
			// ~3.8:1 on white) at `text-xs`, under AA. The exclusion is another
			// `:not()`, matching how the same collision was fixed for `<Button
			// asChild>` and dropdown items; a class cannot win against an unlayered
			// rule, which is the whole point. `whatsapp-phone-link-color.guard.test.ts`
			// pins the attribute and both rules together.
			data-slot="wa-phone"
			// Colour lives HERE, not at the call sites. Four of them passed a colour
			// utility that did nothing (see above), and the component is the only
			// place that knows which of its three branches is rendering — the
			// digit-less branch must NOT be painted like a link. In LIGHT mode
			// `--primary` is `--lagoon-ink`, annotated AA-verified at 5.8:1 in
			// `styles.css`; `.dark` rebinds `--primary` to `--lagoon`, a different
			// value on a different background, so that figure is a light-mode
			// number and not a claim about both themes. The `mailtoHref` anchor
			// beside this one carries the same pair (`wa-email` + `text-primary`),
			// because two peer actions on one row must not render in two colours.
			// `hover:underline` is base for the same reason: the rest of the base is
			// pure layout, so without it an anchor is indistinguishable from the
			// plain text beside it.
			className={cn(
				"inline-flex items-center gap-1.5 text-primary hover:underline",
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
