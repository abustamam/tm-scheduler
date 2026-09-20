-- #801 — role identity moves to the club's role BANK.
--
-- `drizzle-kit generate` emits only the three DDL statements (add `standing`,
-- drop the per-template unique index, add the `template_id IS NULL` check).
-- Everything between them is HAND-WRITTEN: the data fold that makes the check
-- satisfiable, in this exact order, because `role_slots.role_definition_id` is
-- ON DELETE RESTRICT and `role_slots` is the only foreign key into
-- `role_definitions`.
--
-- The fold is FORWARD-ONLY — losing definitions are deleted, so undoing it
-- needs a restore. A migration failure exits non-zero and the Railway deploy
-- fails closed before the server serves traffic.
--
-- Deliberately NOT here: a unique index on
-- `role_slots (meeting_id, role_definition_id, slot_index)`. Step 4 makes it
-- satisfiable, but duplicate indices are constructible today by a race the repo
-- documents (`applyAddRoleSlot` computes `nextIndex` outside its transaction
-- with no lock), and migrations run in the container's startup CMD — an index
-- creation that failed on a pre-existing duplicate this change did not create
-- would block the whole deploy with no in-band remedy.

--> statement-breakpoint
-- STEP 0. The new column. Default true, so every existing row is standing —
-- which is right for a bank row and is corrected for a promoted fork in step 6.
ALTER TABLE "role_definitions" ADD COLUMN "standing" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- STEP 1a. Give a KEYLESS bank row the key of a same-named template fork, so
-- the pair lands in one fold group below. Case-insensitive name is the same
-- rule `matchRoleDefs` applies to an unkeyed row, and it is the only signal
-- available: a club-invented role has `key = NULL` because
-- `applyRoleDefinitionCreate` never wrote one before #801.
--
-- FOUR guards, and the fourth is the one that is not obvious. Each protects
-- `role_definitions_club_key_unique`, which this statement must leave
-- satisfied — and a violation here ABORTS THE MIGRATION, which under the
-- Railway startup CMD aborts the whole deploy with no in-band remedy.
--
--   * `dupes = 1`      — two keyless bank rows sharing a NAME would both adopt.
--   * `keys = 1`       — a name mapping to two different fork keys has no answer.
--   * NOT EXISTS       — the key must be free among this club's keyed bank rows.
--   * `claimants = 1`  — two keyless bank rows with DIFFERENT names must not
--     adopt the same key. The three guards above are all per-NAME, and the
--     NOT EXISTS reads the pre-statement snapshot, so nothing else asks whether
--     this one UPDATE is about to write the same (club_id, key) twice. It is
--     reachable: two forks can share a key under different names, because
--     `materializeTemplateRoles` preserved a club's rename (#445) while
--     `applyTemplateConversion` deep-copied the template — so a club can hold
--     forks "Timekeeper" and "Timer" both keyed `timer`, beside keyless bank
--     rows named "Timer" and "Timekeeper". Every per-name guard passes and both
--     bank rows claim `timer`.
--
-- A contested key is left to step 1b rather than awarded to one of the
-- claimants: picking would fold a member's history onto a role chosen by an
-- `id` comparison. Both rows keep their own slugified key and stay two roles,
-- which is the same outcome as the case below.
--
-- A club-invented role RENAMED in settings after it was forked matches on
-- neither key nor name and is unfoldable from data alone; it stays two roles.
WITH fork AS (
	SELECT
		rd.club_id,
		lower(btrim(rd.name)) AS lname,
		min(rd.key) AS key,
		count(DISTINCT rd.key) AS keys
	FROM role_definitions rd
	WHERE rd.template_id IS NOT NULL AND rd.key IS NOT NULL
	GROUP BY 1, 2
), bare AS (
	SELECT
		rd.id,
		rd.club_id,
		lower(btrim(rd.name)) AS lname,
		count(*) OVER (PARTITION BY rd.club_id, lower(btrim(rd.name))) AS dupes
	FROM role_definitions rd
	WHERE rd.template_id IS NULL AND rd.key IS NULL
), pick AS (
	SELECT
		b.id,
		f.key,
		count(*) OVER (PARTITION BY b.club_id, f.key) AS claimants
	FROM bare b
	JOIN fork f ON f.club_id = b.club_id AND f.lname = b.lname
	WHERE b.dupes = 1
		AND f.keys = 1
		AND NOT EXISTS (
			SELECT 1 FROM role_definitions o
			WHERE o.club_id = b.club_id AND o.template_id IS NULL AND o.key = f.key
		)
)
UPDATE role_definitions rd
SET key = p.key
FROM pick p
WHERE rd.id = p.id AND p.claimants = 1;
--> statement-breakpoint
-- STEP 1b. Every remaining keyless row gets a slugified key, uniquified within
-- the club. `meeting_template_roles.key` is NOT NULL, so a keyless bank role
-- could never be declared by any agenda — under key binding it was a role no
-- meeting shape could name.
--
-- The slug rule is `deriveRoleKey`'s, character for character: lowercase, every
-- non `[a-z0-9]` to `_`, runs collapsed, ends trimmed, empty becomes `role`,
-- then `_2`, `_3` … until free. A loop rather than a window function because
-- the suffix has to avoid BOTH the keys already in the table and the ones this
-- pass is assigning as it goes.
--
-- "Character for character" is GATED, not asserted:
-- `role-identity-fold.integration.test.ts` lifts the `base := …` expression
-- below out of this file and runs it in Postgres against `deriveRoleKey` in
-- node, over a list of names. It has to, because the two engines did NOT agree
-- when that sentence was first written. `lower()` here folds `İ` (U+0130) to a
-- single `i`; JS applies Unicode FULL case mapping, so `"İ".toLowerCase()` is
-- `i` plus a combining dot, the dot is not `[a-z0-9]`, and `İstanbul` slugged
-- to `i_stanbul` against this statement's `istanbul`. `deriveRoleKey` now folds
-- U+0130 before lowercasing (`foldRoleName`), which is the only unconditional
-- lowercase special-case in Unicode and so the whole of the divergence.
--
-- "FREE" MEANS FREE AMONG BANK ROWS, and the `template_id IS NULL` on the
-- EXISTS below is load-bearing rather than tidy scoping. The binding constraint
-- is `role_definitions_club_key_unique`, which is partial on exactly that
-- predicate, so a key held only by a FORK is not taken — and colliding with one
-- is the OUTCOME THIS STEP WANTS: step 2 groups by (club_id, key), so landing
-- on the fork's key is what folds the pair. Without the filter a bank row is
-- pushed off its own key by a row that is about to be deleted. Measured: bank
-- "Ah Counter" (keyless) beside fork "Ah-Counter" keyed `ah_counter` — step 1a
-- misses on the punctuation, this step assigned `ah_counter_2`, step 2 grouped
-- them apart, and the club's slot history ended up on the promoted fork at
-- `standing = false`, where `generateSlotRows` would never place it on an
-- ordinary meeting again.
--
-- Safe against this pass's own writes because the loop is SEQUENTIAL and every
-- row it writes is a bank row: a key assigned on an earlier iteration is
-- visible to the EXISTS on a later one.
DO $fold801$
DECLARE
	r record;
	base text;
	candidate text;
	n int;
BEGIN
	FOR r IN
		SELECT id, club_id, name FROM role_definitions WHERE key IS NULL
		ORDER BY club_id, id
	LOOP
		base := coalesce(
			nullif(
				btrim(
					regexp_replace(
						regexp_replace(lower(r.name), '[^a-z0-9]', '_', 'g'),
						'_+', '_', 'g'
					),
					'_'
				),
				''
			),
			'role'
		);
		candidate := base;
		n := 1;
		WHILE EXISTS (
			SELECT 1 FROM role_definitions o
			WHERE o.club_id = r.club_id
			  AND o.template_id IS NULL
			  AND o.key = candidate
		) LOOP
			n := n + 1;
			candidate := base || '_' || n;
		END LOOP;
		UPDATE role_definitions SET key = candidate WHERE id = r.id;
	END LOOP;
END
$fold801$;
--> statement-breakpoint
-- STEP 2. Pick a survivor per (club_id, key).
--
--   * the `template_id IS NULL` row when one exists — the club's own row is the
--     one its settings edit and its members recognise;
--   * otherwise the row with the MOST `role_slots` referencing it, which
--     minimises re-points and keeps the row carrying the most history;
--   * ties broken on `id` ascending. `role_definitions` has no `created_at` and
--     its `id` is `gen_random_uuid()`, so "the oldest row" is not computable —
--     `id` is not meaningful, it is merely DETERMINISTIC, which is the property
--     that matters for a fold that must produce the same answer twice.
--
-- The survivor's `name` is what the club keeps, preserving
-- `materializeTemplateRoles`' existing contract that a club's rename survives
-- re-materialisation (#445).
DROP TABLE IF EXISTS role_fold_801;
--> statement-breakpoint
CREATE TEMP TABLE role_fold_801 AS
WITH ranked AS (
	SELECT
		rd.id,
		rd.club_id,
		rd.key,
		row_number() OVER w AS rn,
		first_value(rd.id) OVER w AS survivor_id
	FROM role_definitions rd
	WHERE rd.key IS NOT NULL
	WINDOW w AS (
		PARTITION BY rd.club_id, rd.key
		ORDER BY
			(rd.template_id IS NULL) DESC,
			(SELECT count(*) FROM role_slots rs WHERE rs.role_definition_id = rd.id) DESC,
			rd.id ASC
	)
)
SELECT id AS loser_id, survivor_id, club_id, key FROM ranked WHERE rn > 1;
--> statement-breakpoint
-- The slots the re-point is about to MOVE, captured BEFORE it runs —
-- afterwards the losers are gone and the question cannot be asked. Step 4 needs
-- both halves of this: which (meeting, survivor) groups to renumber, and which
-- slots within them arrived from a loser.
DROP TABLE IF EXISTS role_fold_801_moved;
--> statement-breakpoint
CREATE TEMP TABLE role_fold_801_moved AS
SELECT rs.id, rs.meeting_id, f.survivor_id AS role_definition_id
FROM role_slots rs
JOIN role_fold_801 f ON f.loser_id = rs.role_definition_id;
--> statement-breakpoint
DROP TABLE IF EXISTS role_fold_801_groups;
--> statement-breakpoint
CREATE TEMP TABLE role_fold_801_groups AS
SELECT DISTINCT meeting_id, role_definition_id FROM role_fold_801_moved;
--> statement-breakpoint
-- STEP 3. Move every loser's slots onto the survivor. This is the repair: a
-- slot assigned on a forked definition now reads as the surviving bank role
-- everywhere history is keyed on `role_slots.role_definition_id` — the assign
-- picker's "last served" and the season grid's row axis.
UPDATE role_slots rs
SET role_definition_id = f.survivor_id
FROM role_fold_801 f
WHERE rs.role_definition_id = f.loser_id;
--> statement-breakpoint
-- STEP 4. Renumber the touched groups to a contiguous 0..N-1, ORDER-PRESERVING.
--
-- Step 3 can collapse two slots onto one (definition, index) — the reported
-- live case reaches it, where the meeting kept a bank-row slot at index 0 and
-- the hand-added fork generated its own index 0.
--
-- FOLDED-IN SLOTS GO LAST, and that is the whole of this ordering. It is NOT
-- enough to keep the pre-existing slots in their own relative order — an
-- earlier draft ordered by `(slot_index, id)` alone, which does exactly that
-- and is still wrong.
--
-- `evaluates_slot_id` is STORED, but `realignEvaluatorPairs`
-- (`slots-logic.ts`) never reads it: on the next speaker add, remove or move it
-- sorts each paired role's slots and OVERWRITES evaluator i's pointer with
-- speaker i. The pairing is therefore positional over the COMBINED array, so
-- inserting one folded-in evaluator ahead of the existing ones shifts every
-- later evaluator by one — a silent re-pairing that surfaces on an edit made
-- days after the deploy, not on the deploy itself.
--
-- Appending both roles' folded-in slots preserves the correspondence in both
-- directions: the pre-existing speakers and evaluators keep positions 0..k-1
-- pairwise, and the arriving ones take k..n-1 in their own former order, where
-- they were already paired with each other. `(slot_index, id)` within each half
-- is `realignEvaluatorPairs`' own tiebreak, so the halves are ordered the way
-- it would order them.
WITH ordered AS (
	SELECT
		rs.id,
		row_number() OVER (
			PARTITION BY rs.meeting_id, rs.role_definition_id
			ORDER BY (m.id IS NOT NULL), rs.slot_index, rs.id
		) - 1 AS new_index
	FROM role_slots rs
	JOIN role_fold_801_groups g
		ON g.meeting_id = rs.meeting_id
		AND g.role_definition_id = rs.role_definition_id
	LEFT JOIN role_fold_801_moved m ON m.id = rs.id
)
UPDATE role_slots rs
SET slot_index = o.new_index
FROM ordered o
WHERE rs.id = o.id AND rs.slot_index <> o.new_index;
--> statement-breakpoint
-- STEP 5. The losers now have no slots, so the RESTRICT is clear.
DELETE FROM role_definitions rd USING role_fold_801 f WHERE rd.id = f.loser_id;
--> statement-breakpoint
DROP TABLE role_fold_801_groups;
--> statement-breakpoint
DROP TABLE role_fold_801_moved;
--> statement-breakpoint
DROP TABLE role_fold_801;
--> statement-breakpoint
-- STEP 6. Promote in place every survivor that was itself template-scoped — a
-- contest role with no bank twin. Its id does not move, so its slots are
-- untouched; it becomes the club's role, at `standing = false` because it is
-- NOT part of the club's standard meeting shape. `standing`, not `enabled`:
-- promoting at `enabled = false` would generate zero Contestant slots on the
-- contest itself, and would list in /admin/roles as merely switched off, where
-- enabling it backfills an open Chief Judge onto every upcoming meeting.
--
-- Safe against `role_definitions_club_key_unique` because step 2 grouped by
-- (club_id, key) regardless of `template_id`, so after step 5 the pair is
-- already unique across the whole club.
UPDATE role_definitions SET template_id = NULL, standing = false
WHERE template_id IS NOT NULL;
--> statement-breakpoint
-- STEP 7. Dead once every row is NULL: its predicate is `template_id is not
-- null`. Dropped only now, so it kept enforcing per-template uniqueness while
-- forks still existed.
DROP INDEX "role_definitions_club_template_key_unique";
--> statement-breakpoint
-- STEP 8. `role_definitions_club_key_unique` is deliberately left alone — its
-- predicate already reads `key is not null and template_id is null`, which
-- under the new invariant is exactly one row per (club_id, key), and CLAUDE.md
-- records that `db:push` silently ignores a CHANGED predicate on an existing
-- partial index.
--
-- The `template_id` column and its FK stay for now. This CHECK means a
-- code-only revert fails loudly on the first fork attempt instead of silently
-- re-forking. Dropping the column is a follow-up once it has held.
ALTER TABLE "role_definitions" ADD CONSTRAINT "role_definitions_template_id_null" CHECK ("role_definitions"."template_id" is null);
