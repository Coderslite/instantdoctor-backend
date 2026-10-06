CREATE TABLE IF NOT EXISTS `blog_authors` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`slug` varchar(160) NOT NULL,
	`job_title` varchar(160),
	`bio` text,
	`image` varchar(1024),
	`links` json NOT NULL DEFAULT (JSON_ARRAY()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `blog_authors_id` PRIMARY KEY(`id`),
	CONSTRAINT `blog_authors_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `health_tip_categories` ADD COLUMN IF NOT EXISTS `slug` varchar(160);--> statement-breakpoint
ALTER TABLE `health_tip_categories` ADD COLUMN IF NOT EXISTS `description` text;--> statement-breakpoint
ALTER TABLE `health_tip_categories` ADD COLUMN IF NOT EXISTS `meta_title` varchar(160);--> statement-breakpoint
ALTER TABLE `health_tip_categories` ADD COLUMN IF NOT EXISTS `meta_description` varchar(320);--> statement-breakpoint
ALTER TABLE `health_tip_categories` ADD COLUMN IF NOT EXISTS `sort_order` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `author_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `reviewer_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `excerpt` varchar(500);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `image_alt` varchar(255);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `status` enum('draft','published') DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `featured` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `tags` json;--> statement-breakpoint
UPDATE `health_tips` SET `tags` = JSON_ARRAY() WHERE `tags` IS NULL;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `reading_minutes` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `meta_title` varchar(160);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `meta_description` varchar(320);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `focus_keyword` varchar(120);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `canonical_url` varchar(1024);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `noindex` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `reviewed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `health_tips` ADD COLUMN IF NOT EXISTS `updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `health_tip_categories` ADD CONSTRAINT `health_tip_categories_slug_uq` UNIQUE(`slug`);--> statement-breakpoint
ALTER TABLE `health_tips` ADD CONSTRAINT `health_tips_author_id_blog_authors_id_fk` FOREIGN KEY (`author_id`) REFERENCES `blog_authors`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `health_tips` ADD CONSTRAINT `health_tips_reviewer_id_blog_authors_id_fk` FOREIGN KEY (`reviewer_id`) REFERENCES `blog_authors`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `health_tips_status_published_idx` ON `health_tips` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `health_tips_author_idx` ON `health_tips` (`author_id`);--> statement-breakpoint
-- Backfill: tips that were already live stay live; drafts did not exist before.
UPDATE `health_tips` SET `status` = 'published' WHERE `published_at` IS NOT NULL;--> statement-breakpoint
UPDATE `health_tips` SET `updated_at` = COALESCE(`published_at`, `created_at`);--> statement-breakpoint
-- Backfill slugs from titles/names; duplicates get a numeric suffix, unsluggable text falls back to the id.
UPDATE `health_tips` t JOIN (
  SELECT `id`, `base`, ROW_NUMBER() OVER (PARTITION BY `base` ORDER BY `published_at`, `id`) AS `rn`
  FROM (
    SELECT `id`, `published_at`,
      COALESCE(NULLIF(LEFT(TRIM(BOTH '-' FROM REGEXP_REPLACE(REGEXP_REPLACE(LOWER(`title`), '[''’]', ''), '[^a-z0-9]+', '-')), 200), ''), LOWER(`id`)) AS `base`
    FROM `health_tips` WHERE `slug` IS NULL
  ) s
) d ON d.`id` = t.`id`
SET t.`slug` = IF(d.`rn` = 1, d.`base`, CONCAT(d.`base`, '-', d.`rn`));--> statement-breakpoint
UPDATE `health_tip_categories` t JOIN (
  SELECT `id`, `base`, ROW_NUMBER() OVER (PARTITION BY `base` ORDER BY `id`) AS `rn`
  FROM (
    SELECT `id`,
      COALESCE(NULLIF(LEFT(TRIM(BOTH '-' FROM REGEXP_REPLACE(REGEXP_REPLACE(LOWER(`name`), '[''’]', ''), '[^a-z0-9]+', '-')), 150), ''), LOWER(`id`)) AS `base`
    FROM `health_tip_categories` WHERE `slug` IS NULL
  ) s
) d ON d.`id` = t.`id`
SET t.`slug` = IF(d.`rn` = 1, d.`base`, CONCAT(d.`base`, '-', d.`rn`));
