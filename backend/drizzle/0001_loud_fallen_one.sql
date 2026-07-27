ALTER TABLE "rounds" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_client_key_unique" UNIQUE("client_key");