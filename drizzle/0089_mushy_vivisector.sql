CREATE TYPE "public"."access_request_kind" AS ENUM('club', 'district');--> statement-breakpoint
CREATE TABLE "access_request_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_key" text NOT NULL,
	"reason" text NOT NULL,
	"trips" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "access_request_alerts_window_key_unique" UNIQUE("window_key")
);
--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "access_request_kind" NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"club_name" text,
	"club_number" text,
	"district_number" text,
	"message" text,
	"ref" text,
	"notified" boolean DEFAULT false NOT NULL,
	"notify_sent_at" timestamp with time zone,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"notify_last_attempted_at" timestamp with time zone,
	"notify_last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_requests_email_created_idx" ON "access_requests" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "access_requests_created_idx" ON "access_requests" USING btree ("created_at");