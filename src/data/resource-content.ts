/**
 * Loads the raw markdown body for each resource article (#310). The markdown is
 * bundled at build time via Vite's glob import (`?raw`), so there is no runtime
 * filesystem access — this resolves in SSR and in the browser alike.
 */

const files = import.meta.glob("/content/resources/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

// Map "/content/resources/what-to-expect.md" → "what-to-expect".
const bySlug: Record<string, string> = {};
for (const [path, body] of Object.entries(files)) {
	const slug = path.split("/").pop()?.replace(/\.md$/, "");
	if (slug) bySlug[slug] = body;
}

/** The raw markdown body for a resource slug, or `undefined` if none exists. */
export function getResourceMarkdown(slug: string): string | undefined {
	return bySlug[slug];
}
