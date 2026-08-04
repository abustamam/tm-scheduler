// src/components/agenda/club-logo.tsx
//
// The shared render for a club's own uploaded logo. Owns the <img>, the plate
// behind it, the sizing, and the null case so none of that is duplicated
// across the surfaces that show it: the four printed-agenda layouts
// (`meeting-agenda-print.tsx`), the projected deck (`meeting-present.tsx`),
// the Word of the Day poster, and the club role sheet.
import type { CSSProperties } from "react";

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
		<span style={PLATE}>
			<img
				src={logoUrl}
				alt=""
				style={{
					height,
					width: "auto",
					maxWidth,
					objectFit: "contain",
				}}
			/>
		</span>
	);
}

/**
 * The light plate the logo always sits on.
 *
 * A club's upload is an arbitrary image, and the surfaces showing it do not
 * share a background: the poster footer and the role-sheet header band are
 * dark (`INK`, and a `LAGOON→INK` gradient), while the printed agendas and the
 * projected splash are light. Without a plate, a dark-on-transparent logo —
 * the single most common shape a club will upload — is simply invisible on the
 * two dark bands, and the club gets a blank gap with no explanation.
 *
 * White rather than a tinted or bordered treatment because that makes it a
 * no-op wherever it is not needed: on the light surfaces a white plate on
 * white is not visible at all, so the printed agendas look exactly as they did
 * and the plate appears only on the dark bands, which is the only place it has
 * a job. `lineHeight: 0` keeps the inline box from adding descender space.
 *
 * Known residual: this does not rescue a white/reversed logo on the LIGHT
 * splash — white on white is still invisible. Covering both directions needs
 * per-image luminance detection, which is deferred.
 */
const PLATE: CSSProperties = {
	flex: "none",
	display: "inline-flex",
	background: "#fff",
	borderRadius: 4,
	padding: 4,
	lineHeight: 0,
};
