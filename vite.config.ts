import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		nitro({
			rollupConfig: { external: [/^@sentry\//] },
			// Boot the in-process reminder poller (#271 / ADR-0023) once per server
			// start — a Nitro runtime plugin, not an edge/cron job (ADR-0007).
			plugins: ["./src/server/reminder-poller.nitro.ts"],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
