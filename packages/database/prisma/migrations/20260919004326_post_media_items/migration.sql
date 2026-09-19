-- Posts can now carry several media items (image posts and carousels).
-- The single posts.media_id column becomes an ordered post_media_items table.
-- Existing posts are backfilled as one item at position 0 before the old
-- column is dropped, so no data is lost.

-- CreateTable
CREATE TABLE "post_media_items" (
    "post_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "post_media_items_pkey" PRIMARY KEY ("post_id","position")
);

-- Backfill from the old column
INSERT INTO "post_media_items" ("post_id", "media_id", "position")
SELECT "id", "media_id", 0 FROM "posts";

-- CreateIndex
CREATE INDEX "post_media_items_media_id_idx" ON "post_media_items"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_media_items_post_id_media_id_key" ON "post_media_items"("post_id", "media_id");

-- AddForeignKey
ALTER TABLE "post_media_items" ADD CONSTRAINT "post_media_items_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media_items" ADD CONSTRAINT "post_media_items_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the old single-media column
ALTER TABLE "posts" DROP CONSTRAINT "posts_media_id_fkey";
ALTER TABLE "posts" DROP COLUMN "media_id";
