import { Mail } from "lucide-react";
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
import { mailtoHref } from "#/lib/mailto";

/**
 * A member's email (mailto) and phone (WhatsApp) links, whichever are on file,
 * as siblings for the caller's flex row. Shared by the mentorship cards and
 * the orientation checklist's "Get a mentor" item (#939), which show the same
 * contact in the same shape.
 *
 * `mailtoHref`, never raw interpolation (a stored "a@b.com?cc=x" would become
 * live mailto headers), and `data-slot="wa-email"` so the email link takes the
 * same colour as the phone link beside it (see the member page's header).
 */
export function MemberContactLinks({
	name,
	email,
	phone,
}: {
	name: string;
	email: string | null;
	phone: string | null;
}) {
	return (
		<>
			{email ? (
				<a
					href={mailtoHref(email)}
					data-slot="wa-email"
					className="inline-flex items-center gap-1 text-primary hover:underline"
				>
					<Mail className="size-3" aria-hidden />
					{email}
				</a>
			) : null}
			{phone ? <WhatsAppPhoneLink phone={phone} name={name} /> : null}
		</>
	);
}
