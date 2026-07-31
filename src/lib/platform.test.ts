import { describe, expect, it } from "vitest";
import { detectPlatform, type NavigatorLike } from "./platform";

/** Real UA strings — the point of this table is that it survives a UA the
 *  regex author never saw, so paraphrasing them would defeat it. */
const UA = {
	linuxChrome:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	macSafari:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	windowsChrome:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	linuxFirefox:
		"Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
	androidChrome:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
	iphoneSafari:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	ipadSafari:
		"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

function nav(p: Partial<NavigatorLike> & { userAgent: string }): NavigatorLike {
	return { maxTouchPoints: 0, ...p };
}

describe("detectPlatform", () => {
	it("reads desktop off UAs with no client hint", () => {
		expect(detectPlatform(nav({ userAgent: UA.linuxChrome }))).toBe("desktop");
		expect(detectPlatform(nav({ userAgent: UA.macSafari }))).toBe("desktop");
		expect(detectPlatform(nav({ userAgent: UA.windowsChrome }))).toBe(
			"desktop",
		);
		expect(detectPlatform(nav({ userAgent: UA.linuxFirefox }))).toBe("desktop");
	});

	it("reads mobile off Android and iPhone UAs", () => {
		expect(detectPlatform(nav({ userAgent: UA.androidChrome }))).toBe("mobile");
		expect(detectPlatform(nav({ userAgent: UA.iphoneSafari }))).toBe("mobile");
		expect(detectPlatform(nav({ userAgent: UA.ipadSafari }))).toBe("mobile");
	});

	it("prefers the Chromium client hint over the UA", () => {
		// An Android UA the hint contradicts: the browser's own answer wins. This
		// is the desktop-mode request case.
		expect(
			detectPlatform(
				nav({ userAgent: UA.androidChrome, userAgentData: { mobile: false } }),
			),
		).toBe("desktop");
		expect(
			detectPlatform(
				nav({ userAgent: UA.linuxChrome, userAgentData: { mobile: true } }),
			),
		).toBe("mobile");
	});

	it("catches iPadOS masquerading as a Mac via touch points", () => {
		// iPadOS 13+ requests desktop sites by default and reports a Macintosh UA;
		// only maxTouchPoints separates it from a real Mac.
		expect(
			detectPlatform(nav({ userAgent: UA.macSafari, maxTouchPoints: 5 })),
		).toBe("mobile");
		// A real Mac reports 0 even with a trackpad — must stay desktop.
		expect(
			detectPlatform(nav({ userAgent: UA.macSafari, maxTouchPoints: 0 })),
		).toBe("desktop");
	});

	it("does not treat a touch-screen Windows laptop as mobile", () => {
		// The touch-point clause is gated on a Macintosh UA precisely so this
		// common desktop shape is not misread.
		expect(
			detectPlatform(nav({ userAgent: UA.windowsChrome, maxTouchPoints: 10 })),
		).toBe("desktop");
	});
});
