import { defineConfig } from "wxt";

// Target GavelUp server. Prod (unset) → gavelup.app. Dev → set WXT_GAVELUP_URL,
// e.g. `WXT_GAVELUP_URL=http://localhost:3000 bun run dev`. The value is also
// read at runtime via import.meta.env.WXT_GAVELUP_URL (see background.ts).
const GAVELUP_URL = process.env.WXT_GAVELUP_URL ?? "https://gavelup.app";
const gavelupOrigin = `${new URL(GAVELUP_URL).origin}/*`;
const isDev = GAVELUP_URL.startsWith("http://");

export default defineConfig({
	manifest: ({ browser }) => ({
		name: isDev ? "GavelUp Pathways Sync (DEV)" : "GavelUp Pathways Sync",
		description:
			"Sync your club's Base Camp Pathways progress into GavelUp in one click.",
		permissions: ["storage", "activeTab"],
		host_permissions: [
			"https://basecamp.toastmasters.org/*",
			"https://app.basecamp.toastmasters.org/*",
			gavelupOrigin,
		],
		// Toolbar icon with NO popup — clicking it opens the Options page
		// (see background.ts). WXT maps `action` → `browser_action` for Firefox MV2.
		action: {},
		// Firefox-only. A stable add-on id (required to sign/install a persistent
		// .xpi), a floor that guarantees world:"MAIN" content-script support
		// (Firefox 128+), and an honest "collects no data" declaration. Gated on the
		// firefox target so the chrome-mv3 manifest is byte-for-byte unaffected.
		// NOTE: the original id `pathways-sync@gavelup.app` was retired on AMO after a
		// deleted submission — Mozilla permanently blocks reuse of a deleted add-on's
		// id, so this id must never be deleted from AMO once signed.
		...(browser === "firefox"
			? {
					browser_specific_settings: {
						gecko: {
							id: "gavelup-pathways-sync@gavelup.app",
							strict_min_version: "128.0",
							data_collection_permissions: { required: ["none"] },
						},
					},
				}
			: {}),
	}),
});
