// Regenerates `public/og/default.png`, the static card `og-card-logic.ts` serves
// when a render fails (#1411). Run by hand after a change to `DefaultCard` or
// the fonts: `bun run scripts/og-default-card.ts [out.png]` (default
// `public/og/default.png`). Not part of the build; the PNG is committed.
import { readFileSync, writeFileSync } from "node:fs";
import { renderAsync } from "@resvg/resvg-js";
import satori from "satori";
import { DefaultCard, OG_HEIGHT, OG_WIDTH } from "../src/components/og/og-card";

const font = (file: string) =>
	readFileSync(new URL(`../src/assets/og-fonts/${file}`, import.meta.url));
const mark = `data:image/svg+xml;base64,${readFileSync(
	new URL("../public/favicon.svg", import.meta.url),
).toString("base64")}`;

const svg = await satori(DefaultCard({ markSrc: mark }), {
	width: OG_WIDTH,
	height: OG_HEIGHT,
	fonts: [
		{
			name: "Fraunces",
			data: font("Fraunces-SemiBold.woff"),
			weight: 600,
			style: "normal",
		},
		{
			name: "Manrope",
			data: font("Manrope-Regular.woff"),
			weight: 400,
			style: "normal",
		},
		{
			name: "Manrope",
			data: font("Manrope-Bold.woff"),
			weight: 700,
			style: "normal",
		},
	],
});
const png = (
	await renderAsync(svg, { fitTo: { mode: "width", value: OG_WIDTH } })
).asPng();
const out = process.argv[2] ?? "public/og/default.png";
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
