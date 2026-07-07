import { defineConfig } from "wxt";

// Target GavelUp server. Prod (unset) → gavelup.app. Dev → set WXT_GAVELUP_URL,
// e.g. `WXT_GAVELUP_URL=http://localhost:3000 bun run dev`. The value is also
// read at runtime via import.meta.env.WXT_GAVELUP_URL (see background.ts).
const GAVELUP_URL = process.env.WXT_GAVELUP_URL ?? "https://gavelup.app";
const gavelupOrigin = `${new URL(GAVELUP_URL).origin}/*`;
const isDev = GAVELUP_URL.startsWith("http://");

export default defineConfig({
	manifest: {
		name: isDev ? "GavelUp Pathways Sync (DEV)" : "GavelUp Pathways Sync",
		description: "Sync your club's Base Camp Pathways progress into GavelUp in one click.",
		permissions: ["storage", "activeTab"],
		host_permissions: [
			"https://basecamp.toastmasters.org/*",
			"https://app.basecamp.toastmasters.org/*",
			gavelupOrigin,
		],
	},
});
