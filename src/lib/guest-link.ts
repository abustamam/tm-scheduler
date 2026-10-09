import { z } from "zod";

/**
 * What a guest link shows an officer before it is made, and what it recomputes
 * when it is (#1127): the keeper Person as the merge would leave it, as name,
 * goes-by name, email and phone and nothing else. Declared ONCE: the preview's
 * result, the pure rule that computes it (`guestLinkResult`), the schema the link's
 * `expected` input is parsed with, and the comparison all read this shape, so a
 * field added to one cannot be forgotten by another.
 *
 * In `lib/` and not beside the server code because the confirm dialog and the
 * server function's validator both need it, and neither may import `#/db`.
 */
export const guestLinkPreviewSchema = z.object({
	name: z.string(),
	preferredName: z.string().nullable(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
});

export type GuestLinkPreview = z.infer<typeof guestLinkPreviewSchema>;

/** Every field of the shape, compared; the keys come from the schema. */
export function sameGuestLinkPreview(
	a: GuestLinkPreview,
	b: GuestLinkPreview,
): boolean {
	return (
		Object.keys(guestLinkPreviewSchema.shape) as (keyof GuestLinkPreview)[]
	).every((key) => a[key] === b[key]);
}
