/**
 * Create or drop a worktree's own test database (#980).
 *
 *   bun scripts/worktree-test-db.ts ensure   # called by scripts/setup-worktree.sh
 *   bun scripts/worktree-test-db.ts drop     # called by scripts/teardown-worktree.sh
 *
 * The rules live in `worktree-test-db-logic.ts`; this file only supplies the
 * worktree root, its label, the server and the real `db:push --force`.
 * Imports are relative for the reason given there.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	baseUrl,
	dropWorktreeTestDb,
	ensureWorktreeTestDb,
} from "./worktree-test-db-logic";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

function label(): string {
	const branch = execFileSync("git", ["branch", "--show-current"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	// Detached HEAD: the absolute path, not its basename, which two worktrees
	// in different parents can share.
	return branch || root;
}

function dbPush(url: string): void {
	const push = spawnSync("bun", ["run", "db:push", "--force"], {
		cwd: root,
		env: { ...process.env, DATABASE_URL: url },
		encoding: "utf8",
	});
	if (push.status !== 0) {
		process.stderr.write(push.stdout + push.stderr);
		throw new Error("db:push --force failed");
	}
}

async function main(cmd: string | undefined): Promise<void> {
	if (cmd === "ensure") {
		await ensureWorktreeTestDb({
			root,
			label: label(),
			base: baseUrl(root),
			syncSchema: dbPush,
			log: console.log,
		});
	} else if (cmd === "drop") {
		await dropWorktreeTestDb(root, console.log);
	} else {
		console.error("usage: bun scripts/worktree-test-db.ts ensure|drop");
		process.exit(2);
	}
}

main(process.argv[2]).catch((err: unknown) => {
	console.error(`  ! ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
