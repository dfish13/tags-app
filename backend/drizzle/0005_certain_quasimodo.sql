CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"start_time" text,
	"title" text,
	"course" text,
	"notes" text,
	"tags_round" boolean DEFAULT true NOT NULL,
	"round_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_round_id_unique" UNIQUE("round_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_banner" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"message" text NOT NULL,
	"link_url" text,
	"link_label" text,
	"starts_on" date,
	"ends_on" date,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "site_banner_singleton" CHECK ("site_banner"."id" = 1)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
