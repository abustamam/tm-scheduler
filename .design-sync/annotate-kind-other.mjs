// Post-process the Tailwind-compiled stylesheet (cfg.cssEntry) so the
// Claude Design token classifier does NOT surface Tailwind's own
// animation/transition plumbing as design tokens. Adds `/* @kind other */`
// after 9 tokens that would otherwise be misclassified.
//
// Run AFTER regenerating compiled-styles.css:
//   bunx @tailwindcss/cli@4 -i src/styles.css -o .design-sync/compiled-styles.css
//   node .design-sync/annotate-kind-other.mjs
//
// Idempotent: re-running is a no-op (skips tokens already annotated).
// The DS source (src/styles.css) is upstream/read-only, so this lives here
// as a sync post-step rather than an edit to the source.
import fs from "node:fs";

const KIND = "/* @kind other */";
const path = process.argv[2] || ".design-sync/compiled-styles.css";
let css = fs.readFileSync(path, "utf8");
let n = 0;

// (a) Theme-level defaults emitted near :root — annotate inline after the
//     declaration. These are Tailwind's transition/animation defaults, not
//     brand/semantic design tokens.
const themeTokens = [
	"--ease-in-out",
	"--animate-spin",
	"--default-transition-duration",
	"--default-transition-timing-function",
];
for (const t of themeTokens) {
	const re = new RegExp(`(^\\s*${t}\\s*:[^;\\n]*;)(?!\\s*/\\* @kind)`, "m");
	const next = css.replace(re, (m) => (++n, `${m} ${KIND}`));
	if (next === css) console.warn(`annotate: theme token not found or already annotated: ${t}`);
	css = next;
}

// (b) @property registrations for Tailwind utility internals — annotate
//     after the closing brace of each @property block.
const propTokens = [
	"--tw-border-style",
	"--tw-blur",
	"--tw-backdrop-blur",
	"--tw-duration",
	"--tw-outline-style",
];
for (const t of propTokens) {
	const re = new RegExp(`(@property ${t}\\s*\\{[^}]*\\})(?!\\s*/\\* @kind)`, "m");
	const next = css.replace(re, (m) => (++n, `${m} ${KIND}`));
	if (next === css) console.warn(`annotate: @property block not found or already annotated: ${t}`);
	css = next;
}

fs.writeFileSync(path, css);
console.log(`annotate-kind-other: added ${KIND} to ${n} token(s) in ${path}`);
