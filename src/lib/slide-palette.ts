/**
 * The deck's own colours. A slide is drawn in these in BOTH themes, like a
 * projector, so they are raw hex rather than theme tokens. One module so the
 * presenter (`meeting-present.tsx`), the next-meeting body and the `/tour`
 * page's sample deck read the same values and cannot drift.
 */
// Official brand palette (sampled from the wordmark) so chrome matches the logo.
export const INK = "#2b2b2b";
export const MAROON = "#770D29";
export const NAVY = "#004062";
export const GROUND = "#f3f4f4";
export const MUTED = "#565656";
export const GOLD = "#f3dd94";
export const NAVY_GRADIENT_TOP = "#0a4f78";
export const NAVY_GRADIENT_BOTTOM = "#002a41";
