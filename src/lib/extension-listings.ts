/**
 * Where a club admin installs the GavelUp browser extension (#1492): the unlisted
 * Chrome Web Store and Firefox AMO listings. Both are `null` until the maintainer
 * submits the listings and pastes the URLs here (`docs/extension-release.md`).
 * A null listing renders no link.
 */
export const EXTENSION_LISTINGS: {
	chrome: string | null;
	firefox: string | null;
} = {
	chrome: null,
	firefox: null,
};
