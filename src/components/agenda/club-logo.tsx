// src/components/agenda/club-logo.tsx
//
// The shared render for a club's own uploaded logo. Owns the <img>, the
// sizing, and the null case so none of that is duplicated across the surfaces
// that show it: the four printed-agenda layouts (`meeting-agenda-print.tsx`),
// the projected deck (`meeting-present.tsx`), the Word of the Day poster, and
// the club role sheet.
type Props = {
	/** Already-versioned (`?v=<updatedAt>`) or null when the club has none. */
	logoUrl: string | null;
	/**
	 * CSS height. Defaults to the printed-page value.
	 *
	 * The projected deck sizes everything in `cqw` (container-query width) so a
	 * slide scales to whatever it is thrown at, and a fixed pixel height would
	 * be a postage stamp on a projector and enormous in the slide-overview
	 * grid. Print surfaces stay in px, where the page is a known size.
	 */
	height?: number | string;
	/** Width ceiling, same units story as `height`. */
	maxWidth?: number | string;
};

/**
 * A club's own logo.
 *
 * Height-locked with `width: auto` and a `maxWidth` ceiling rather than a fixed
 * box: a club's supplied image is either a wide wordmark or a square crest, and
 * a fixed box distorts one of them. `objectFit: contain` keeps whichever shape
 * arrives from clipping or stretching.
 *
 * `alt=""` — decorative. The club's name is always the adjacent text, so this
 * image carries nothing an assistive reader needs. It also must not name any
 * mark in text a screen reader would announce (ADR-0024 constraint 1).
 *
 * `logoUrl == null` renders nothing at all: no wrapper, no spacer, no
 * placeholder, so a club with no logo renders exactly as it always has.
 */
export function ClubLogo({ logoUrl, height = 48, maxWidth = 180 }: Props) {
	if (logoUrl == null) return null;
	return (
		<img
			src={logoUrl}
			alt=""
			style={{
				flex: "none",
				height,
				width: "auto",
				maxWidth,
				objectFit: "contain",
			}}
		/>
	);
}
