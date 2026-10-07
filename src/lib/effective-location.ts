/**
 * The location a meeting gets when nobody typed one (#1086): the standing
 * schedule's own location, else the club's default, else none. One home for the
 * rule so the forms, the top-up and the MCP plan cannot drift apart.
 */
export function effectiveLocation(
	ruleLocation: string | null | undefined,
	clubDefault: string | null | undefined,
): string | null {
	return ruleLocation ?? clubDefault ?? null;
}
