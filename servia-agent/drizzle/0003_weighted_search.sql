ALTER TABLE "knowledge_chunks" ADD COLUMN "normalized_heading" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, normalized_heading), 'A') || setweight(to_tsvector('simple'::regconfig, normalized_content), 'B')) STORED NOT NULL;--> statement-breakpoint
-- Dropping the column dropped its GIN index; recreate it.
CREATE INDEX IF NOT EXISTS "knowledge_chunks_search_idx" ON "knowledge_chunks" USING gin ("search_vector");
