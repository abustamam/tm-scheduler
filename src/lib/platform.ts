// Which WhatsApp entry point a client should be sent to (#485). `wa.me` is a
// DEVICE redirector: on a phone it hands off to the installed app, but on a
// desktop it lands on an "open in app" interstitial that is a dead end without
// the desktop client installed. Desktop needs `web.whatsapp.com` directly.
//
// Takes the navigator-ish object as a PARAMETER rather than reading the global,
// so this is unit-testable over real UA strings without stubbing `navigator`.

export interface NavigatorLike {
	userAgent: string;
	maxTouchPoints: number;
	/** Chromium-only (`navigator.userAgentData`); absent in Safari and Firefox. */
	userAgentData?: { mobile?: boolean };
}

export type Platform = "mobile" | "desktop";

export function detectPlatform(nav: NavigatorLike): Platform {
	// Chromium's client hint is authoritative where it exists (Android Chrome,
	// desktop Chrome/Edge) — it is the browser's own answer, not a UA guess.
	if (typeof nav.userAgentData?.mobile === "boolean") {
		return nav.userAgentData.mobile ? "mobile" : "desktop";
	}
	// Safari and Firefox ship no client hint, so fall back to the UA.
	if (/Android|iPhone|iPod|iPad/i.test(nav.userAgent)) return "mobile";
	// iPadOS 13+ requests desktop sites by default and reports a Macintosh UA.
	// Touch points are what separate it from an actual Mac (a Mac reports 0).
	if (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
		return "mobile";
	return "desktop";
}
