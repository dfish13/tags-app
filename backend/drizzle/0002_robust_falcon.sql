ALTER TABLE "round_entries" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "join_code" text;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "code_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_incoming_tag_id_unique" UNIQUE("round_id","incoming_tag_id");--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_join_code_unique" UNIQUE("join_code");