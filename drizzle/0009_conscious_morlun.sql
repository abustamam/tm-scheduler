CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"original_join_date" timestamp,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "people_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
-- Add person_id NULLABLE first so the backfill can populate it before the
-- NOT NULL constraint is applied (existing members rows have no person yet).
ALTER TABLE "members" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "members_person_idx" ON "members" USING btree ("person_id");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Backfill people from existing members (ADR-0008 / #64), deduping by EMAIL
-- ONLY (Customer ID is not persisted yet). A non-blank email that maps to
-- exactly one distinct (normalized) name is "clean": every member row with that
-- email collapses into ONE person. Blank emails and emails shared by 2+ distinct
-- names stay distinct — one person per row. NEVER merge on name.
-- ---------------------------------------------------------------------------
-- 1. Assign each member row a person grouping key.
CREATE TEMP TABLE "_member_person_keys" ON COMMIT DROP AS
WITH "norm" AS (
	SELECT
		m."id" AS member_id,
		NULLIF(lower(trim(m."email")), '') AS email_norm,
		lower(trim(m."name")) AS name_norm
	FROM "members" m
),
"clean_emails" AS (
	SELECT email_norm
	FROM "norm"
	WHERE email_norm IS NOT NULL
	GROUP BY email_norm
	HAVING count(DISTINCT name_norm) = 1
)
SELECT
	n.member_id,
	CASE
		WHEN n.email_norm IS NOT NULL
			AND n.email_norm IN (SELECT email_norm FROM "clean_emails")
			THEN 'email:' || n.email_norm
		ELSE 'row:' || n.member_id::text
	END AS person_key
FROM "norm" n;
--> statement-breakpoint
-- 2. Materialize one person per distinct key. Canonical name/email/phone/user
--    come from a representative row (earliest created_at, then id);
--    original_join_date is the MIN across the group (first-ever TM join).
CREATE TEMP TABLE "_people_new" ON COMMIT DROP AS
SELECT
	gen_random_uuid() AS id,
	agg.person_key,
	rep.name,
	rep.email,
	rep.phone,
	agg.original_join_date,
	rep.user_id
FROM (
	SELECT k.person_key, min(m."original_join_date") AS original_join_date
	FROM "_member_person_keys" k
	JOIN "members" m ON m."id" = k.member_id
	GROUP BY k.person_key
) agg
JOIN LATERAL (
	SELECT m2."name", m2."email", m2."phone", m2."user_id"
	FROM "_member_person_keys" k2
	JOIN "members" m2 ON m2."id" = k2.member_id
	WHERE k2.person_key = agg.person_key
	ORDER BY m2."created_at" ASC, m2."id" ASC
	LIMIT 1
) rep ON true;
--> statement-breakpoint
-- 3. Insert the deduped people (customer_id NULL — not persisted yet).
INSERT INTO "people" ("id", "customer_id", "name", "email", "phone", "original_join_date", "user_id")
SELECT id, NULL, name, email, phone, original_join_date, user_id
FROM "_people_new";
--> statement-breakpoint
-- 4. Point every member row at its person.
UPDATE "members" m
SET "person_id" = pn.id
FROM "_member_person_keys" k
JOIN "_people_new" pn ON pn.person_key = k.person_key
WHERE m."id" = k.member_id;
--> statement-breakpoint
-- Every member now has a person; enforce it.
ALTER TABLE "members" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
-- original_join_date now lives on people only.
ALTER TABLE "members" DROP COLUMN "original_join_date";
