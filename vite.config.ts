import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// @resvg/resvg-js is a native addon (#1411). Its js-binding.js statically
	// requires every platform's .node package; on Linux the matching one is
	// installed, so the dev dep optimizer tried to bundle a .node file and died
	// with UNLOADABLE_DEPENDENCY. Keep it out of optimization and external.
	optimizeDeps: { exclude: ["@resvg/resvg-js"] },
	ssr: {
		external: ["@resvg/resvg-js"],
		optimizeDeps: { exclude: ["@resvg/resvg-js"] },
	},
	plugins: [
		devtools(),
		nitro({
			rollupConfig: { external: [/^@sentry\//] },
			// Boot the in-process reminder poller (#271 / ADR-0023) once per server
			// start — a Nitro runtime plugin, not an edge/cron job (ADR-0007).
			// The malformed-URI guard (#895) wraps `nitroApp.fetch` so a path h3
			// cannot decode gets the branded 404 instead of a dropped socket.
			plugins: [
				"./src/server/reminder-poller.nitro.ts",
				"./src/server/malformed-uri.nitro.ts",
			],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
