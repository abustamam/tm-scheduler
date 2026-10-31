// One-time "put GavelUp on your home screen" hint (#1428). Pure decision plus
// the two localStorage keys it reads. Every storage access is wrapped: a
// throwing store (private window, blocked site data) means "never offer".

export const CLAIMS_KEY = "gavelup:claims";
export const DISMISSED_KEY = "gavelup:install-dismissed";
/** Dispatched on `window` after `noteClaim()` so the root-mounted hint reacts. */
export const CLAIM_EVENT = "gavelup:claim-noted";
export const HINT_DELAY_MS = 4000;

export interface InstallEligibility {
	claims: number;
	dismissed: boolean;
	standalone: boolean;
	isPhone: boolean;
}

export function shouldOfferInstall({
	claims,
	dismissed,
	standalone,
	isPhone,
}: InstallEligibility): boolean {
	return claims >= 2 && !dismissed && !standalone && isPhone;
}

/** Counts one claim on this device; returns the new total, or 0 when storage fails. */
export function readClaims(): number {
	try {
		const n = Number.parseInt(
			window.localStorage.getItem(CLAIMS_KEY) ?? "0",
			10,
		);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

export function noteClaim(): number {
	let next = 0;
	try {
		next = readClaims() + 1;
		window.localStorage.setItem(CLAIMS_KEY, String(next));
	} catch {
		return 0;
	}
	try {
		window.dispatchEvent(new Event(CLAIM_EVENT));
	} catch {
		// nothing listens; the count is already stored
	}
	return next;
}

/** A failed read counts as dismissed: never offer when storage is unusable. */
export function readDismissed(): boolean {
	try {
		return window.localStorage.getItem(DISMISSED_KEY) !== null;
	} catch {
		return true;
	}
}

/** Returns false when the flag could not be stored. */
export function markDismissed(): boolean {
	try {
		window.localStorage.setItem(DISMISSED_KEY, "1");
		return true;
	} catch {
		return false;
	}
}

export function detectStandalone(): boolean {
	try {
		return (
			window.matchMedia("(display-mode: standalone)").matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true
		);
	} catch {
		return false;
	}
}

export function detectPhone(): boolean {
	try {
		return (
			window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 768
		);
	} catch {
		return false;
	}
}

/** iOS Safari (not Chrome/Firefox/Edge on iOS, which cannot add to home screen the same way). */
export function isIosSafari(ua: string = navigator.userAgent): boolean {
	return (
		/iP(hone|ad|od)/.test(ua) &&
		/Safari/.test(ua) &&
		!/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
	);
}
