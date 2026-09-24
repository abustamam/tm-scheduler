/**
 * The network boundary for Client ID Metadata Document fetches (#852).
 *
 * `@better-auth/cimd/node`'s transport resolves the host once, refuses any
 * non-public address, pins the connection to the address it checked, and
 * never follows a redirect — the guarantees the plugin requires and a plain
 * `fetch` cannot give. It is re-exported through this one module so a test
 * can `vi.mock("#/lib/cimd-transport")` and serve a fixture instead of
 * calling claude.ai. Nothing else belongs here.
 */
export { fetchClientMetadataResource } from "@better-auth/cimd/node";
