import {
	type LucideIcon,
	Mail,
	MessageCircle,
	MessageSquare,
	Phone,
} from "lucide-react";
import type { ContactMethod } from "#/lib/preferred-contact";

/**
 * The one icon per preferred contact method (#1093), shared by the roster's
 * preference icon and the member page's links, so a method looks the same
 * everywhere. `MessageCircle` is also what `WhatsAppPhoneLink` draws.
 */
export const CONTACT_METHOD_ICONS: Record<ContactMethod, LucideIcon> = {
	email: Mail,
	call: Phone,
	sms: MessageSquare,
	whatsapp: MessageCircle,
};
