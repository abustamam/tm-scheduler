/**
 * `src/db/auth-schema.ts` declares every table the installed Better Auth
 * plugins require (#842 / ADR-0027).
 *
 * That file is hand-maintained, so nothing generates it and nothing checks it.
 * The Drizzle adapter resolves a model by EXPORT NAME in the schema namespace
 * (`schema[model]`) and a field by COLUMN PROPERTY on that table
 * (`schemaModel[field]`), and it discovers a missing one at the moment a
 * request needs it — so the failure mode is a 500 on a user's first OAuth
 * sign-in, in production, with every build gate green.
 *
 * ## Why the expectation is read off the plugins
 *
 * A list of table names written HERE passes forever while a patch bump adds a
 * table, which is the same failure one level removed. So the expected set comes
 * from `Object.keys(plugin.schema)` on the plugins `src/lib/auth.ts` actually
 * registers.
 *
 * It has already earned that: #842's own issue body named five OAuth tables
 * from the docs, and `@better-auth/mcp@1.7.5` declares seven — `oauthResource`
 * and `oauthClientResource` were missing, and a hand-written list would have
 * been written from the same five.
 *
 * ## The three assertions, and why the third needs a database
 *
 * The first two are what the adapter looks up. The third is whether the
 * committed migrations actually CREATE what the first two declare: schema.ts
 * and `drizzle/` are separate artifacts, and CI's drift check compares
 * schema.ts to its own snapshot rather than to a migrated database. A table
 * declared in schema.ts whose migration was never generated passes both static
 * checks and fails at runtime exactly like a missing declaration.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import {
	AUTH_CONSENT_PATH,
	AUTH_SIGNIN_PATH,
	MCP_RESOURCE_PATH,
} from "#/lib/well-known-forward";
import { hasTestDb } from "#/test/db";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNNER = join(REPO_ROOT, "scripts", "migrate.ts");
const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
/** Per-run so two suites (or two agents) never collide on a database name. */
const SUFFIX = randomBytes(4).toString("hex");

/**
 * The plugins as `src/lib/auth.ts` registers them.
 *
 * Constructed here rather than imported from there because importing `auth`
 * drags in `#/db` and a live `DATABASE_URL`, and the two static assertions
 * below need no database at all. The options that could change the declared
 * SCHEMA are the ones that matter, and they come from the same constants
 * `src/lib/auth.ts` uses — `well-known-discovery.integration.test.ts` is what
 * holds the rest of that configuration against the real instance.
 */
const PLUGINS = [
	jwt(),
	mcp({
		loginPage: AUTH_SIGNIN_PATH,
		consentPage: AUTH_CONSENT_PATH,
		resource: `${process.env.BETTER_AUTH_URL}${MCP_RESOURCE_PATH}`,
	}),
];

/** `{ model: [field, …] }`, exactly as the adapter will look them up. */
const REQUIRED: ReadonlyArray<readonly [string, readonly string[]]> =
	PLUGINS.flatMap((plugin) =>
		Object.entries(plugin.schema ?? {}).map(
			([model, definition]) =>
				[model, Object.keys(definition.fields ?? {})] as const,
		),
	);

function tableFor(model: string): PgTable {
	const exported = (schema as Record<string, unknown>)[model];
	if (!is(exported, PgTable)) {
		throw new Error(
			`#/db/schema exports no Drizzle table named "${model}". The adapter looks a model up by this exact name, so add it to src/db/auth-schema.ts and re-export it from src/db/schema.ts.`,
		);
	}
	return exported;
}

describe("auth-schema declares every table the installed plugins need (#842)", () => {
	it("registers more than the four original Better Auth tables", () => {
		// A cheap canary on the mechanism itself: if `plugin.schema` ever stops
		// being the shape this guard reads, `REQUIRED` silently empties and every
		// assertion below passes vacuously.
		expect(REQUIRED.length).toBeGreaterThanOrEqual(8);
		expect(REQUIRED.map(([model]) => model)).toContain("oauthClient");
		expect(REQUIRED.map(([model]) => model)).toContain("jwks");
	});

	it.each(
		REQUIRED.map(([model]) => model),
	)("exports a table for the %s model", (model) => {
		expect(() => tableFor(model)).not.toThrow();
	});

	it.each(REQUIRED)("declares every field of %s", (model, fields) => {
		const columns = getTableColumns(tableFor(model));
		// `id` is implicit in Better Auth's model definitions and explicit in
		// every Drizzle table, so it is checked separately rather than expected
		// in `fields`.
		expect(Object.keys(columns)).toContain("id");
		for (const field of fields) {
			expect(Object.keys(columns)).toContain(field);
		}
	});
});

describe.skipIf(!hasTestDb)(
	"the committed migrations create those tables (#842)",
	() => {
		const database = `tm_oauth842_${SUFFIX}`;
		let admin: Client;
		let migrated: Client;

		beforeAll(async () => {
			admin = new Client({ connectionString: TEST_URL });
			await admin.connect();
			// Identifier, so it cannot be a bind parameter. Built from a literal
			// prefix and a hex suffix, never from anything external.
			await admin.query(`create database "${database}"`);

			const url = new URL(TEST_URL);
			url.pathname = `/${database}`;
			const result = await runMigrate(url.toString());
			expect(
				result.code,
				`the startup migration runner failed:\n${result.output}`,
			).toBe(0);

			migrated = new Client({ connectionString: url.toString() });
			await migrated.connect();
		}, 180_000);

		afterAll(async () => {
			await migrated?.end();
			await admin?.query(`drop database if exists "${database}" with (force)`);
			await admin?.end();
		});

		it("creates every plugin table, with every declared column", async () => {
			// Read from the MIGRATED database, and name the table and column the
			// way Drizzle does, so a table declared under one name in schema.ts and
			// migrated under another fails here rather than in production.
			const missing: string[] = [];
			for (const [model, fields] of REQUIRED) {
				const table = tableFor(model);
				const tableName = getTableName(table);
				const columns = getTableColumns(table);
				const { rows } = await migrated.query<{ column_name: string }>(
					"select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
					[tableName],
				);
				if (rows.length === 0) {
					missing.push(`${tableName} (whole table)`);
					continue;
				}
				const present = new Set(rows.map((row) => row.column_name));
				for (const field of ["id", ...fields]) {
					const columnName = columns[field]?.name;
					if (!columnName || !present.has(columnName)) {
						missing.push(`${tableName}.${columnName ?? field}`);
					}
				}
			}
			expect(missing).toEqual([]);
		}, 60_000);
	},
);

function runMigrate(url: string): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("bun", [RUNNER], {
			cwd: REPO_ROOT,
			env: { ...process.env, DATABASE_URL: url },
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, output }));
	});
}
