// src/components/agenda/club-logo.tsx
//
// The shared render for a club's own uploaded logo on the printed agenda
// header. Owns the <img>, the sizing, and the null case so none of that is
// duplicated across the four print layouts (`meeting-agenda-print.tsx`).
type Props = {
	/** Already-versioned (`?v=<updatedAt>`) or null when the club has none. */
	logoUrl: string | null;
};

/**
 * A club's own logo, rendered left of its name on the printed agenda header.
 *
 * `height: 48px` with `width: auto` + `maxWidth: 180px` (not a fixed box):
 * a club's supplied image is either a wide wordmark or a square crest, and a
 * fixed box distorts one of them. `objectFit: contain` keeps whichever shape
 * arrives from clipping or stretching within that box.
 *
 * `alt=""` — decorative. The club's name is the adjacent text; this image
 * carries no information an assistive reader needs, and this label must not
 * name any mark in text a screen reader would announce.
 *
 * `logoUrl == null` renders nothing at all: no wrapper, no spacer, no
 * placeholder, so a club with no logo prints exactly as it always has.
 */
export function ClubLogo({ logoUrl }: Props) {
	if (logoUrl == null) return null;
	return (
		<img
			src={logoUrl}
			alt=""
			style={{
				flex: "none",
				height: 48,
				width: "auto",
				maxWidth: 180,
				objectFit: "contain",
			}}
		/>
	);
}
