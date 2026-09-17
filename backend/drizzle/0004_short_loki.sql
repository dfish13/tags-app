ALTER TABLE "round_entries" ADD COLUMN "checked_in_at" timestamp;--> statement-breakpoint
ALTER TABLE "round_entries" ADD COLUMN "checked_in_by" text;--> statement-breakpoint
-- Every entry that existed before check-in became a separate step WAS a
-- participant — that was the only thing an entry could be. Leaving these null
-- would retroactively demote every historical round to a list of signups, and
-- would drop them out of the counts, the stats pages and the replay.
--
-- updated_at rather than now(): it is the closest real timestamp on the row,
-- and it doesn't claim last season's rounds were checked in on deploy day.
-- checked_in_by stays null — nobody did this, a migration did.
UPDATE "round_entries" SET "checked_in_at" = "updated_at" WHERE "checked_in_at" IS NULL;
