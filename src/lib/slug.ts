/**
 * Turn a display name into a URL slug: lowercase, non-alphanumeric runs → "-",
 * trimmed. The migration backfill mirrors these rules in SQL.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
