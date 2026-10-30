// protects: the top progress bar (#1424) is mounted once in the root document.
// fails_when: `<RouteProgress />` is deleted from __root.tsx (the component's own
//   tests stay green with nothing rendering it), or only a comment mentions it.
// no_claim: the bar's behaviour (route-progress.test.tsx) or its look.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const root = readSource(
	resolve(dirname(fileURLToPath(import.meta.url)), "__root.tsx"),
);

describe("__root.tsx mounts the route progress bar", () => {
	it("renders <RouteProgress /> in the body", () => {
		const body = root.slice(root.indexOf("<body"));
		expect(body).toContain("<RouteProgress />");
	});
	it("imports it", () => {
		expect(root).toMatch(/import \{ RouteProgress \} from [^;]*route-progress/);
	});
});
