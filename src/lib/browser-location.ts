/**
 * Full-document navigations, behind a seam a test can replace (#843).
 *
 * `window.location`'s methods are unforgeable in jsdom — they cannot be spied
 * on or redefined — so a page that calls them directly can only be tested for
 * what it SENDS, never for where it then GOES. On `/oauth/consent` the second
 * half is the part that matters: an Approve that posts correctly and then
 * navigates nowhere leaves claude.ai waiting forever with every test green.
 */
export function assignLocation(url: string): void {
	window.location.assign(url);
}

export function replaceLocation(url: string): void {
	window.location.replace(url);
}

export function reloadLocation(): void {
	window.location.reload();
}
