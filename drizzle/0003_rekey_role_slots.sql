ALTER TABLE "role_slots" DROP CONSTRAINT "role_slots_assigned_user_id_user_id_fk";--> statement-breakpoint
DROP INDEX "role_slots_assigned_user_idx";--> statement-breakpoint
ALTER TABLE "role_slots" DROP COLUMN "assigned_user_id";--> statement-breakpoint
ALTER TABLE "role_slots" ADD COLUMN "assigned_member_id" uuid;--> statement-breakpoint
ALTER TABLE "role_slots" ADD CONSTRAINT "role_slots_assigned_member_id_members_id_fk" FOREIGN KEY ("assigned_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_slots_assigned_member_idx" ON "role_slots" USING btree ("assigned_member_id");
