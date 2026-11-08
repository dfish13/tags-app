CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"start_time" text,
	"title" text,
	"course" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
