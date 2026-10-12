import { z } from "zod";

/**
 * What a guest link shows an officer before it is made, and what it recomputes
 * when it is (#1127): the record that STAYS (the other guest's Person, which a link
 * never writes: name, goes-by name, email and phone, exactly as they are) and the
 * email and phone this guest has of its own, which are recorded so a Separate can
 * give them back. Nothing else about either side. Declared ONCE: the preview's
 * result, the schema the link's `expected` input is parsed with, and the comparison
 * all read this shape, so a field added to one cannot be forgotten by another.
 *
 * In `lib/` and not beside the server code because the confirm dialog and the
 * server function's validator both need it, and neither may import `#/db`.
 */
export const guestLinkPreviewSchema = z.object({
	kept: z.object({
		name: z.string(),
		preferredName: z.string().nullable(),
		email: z.string().nullable(),
		phone: z.string().nullable(),
	}),
	own: z.object({
		email: z.string().nullable(),
		phone: z.string().nullable(),
	}),
});

export type GuestLinkPreview = z.infer<typeof guestLinkPreviewSchema>;

/** Every field of the shape, compared. */
export function sameGuestLinkPreview(
	a: GuestLinkPreview,
	b: GuestLinkPreview,
): boolean {
	return (
		a.kept.name === b.kept.name &&
		a.kept.preferredName === b.kept.preferredName &&
		a.kept.email === b.kept.email &&
		a.kept.phone === b.kept.phone &&
		a.own.email === b.own.email &&
		a.own.phone === b.own.phone
	);
}
