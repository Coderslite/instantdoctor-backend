CREATE TABLE `blog_post_views` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`post_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`view_id` char(36) NOT NULL,
	`visitor_hash` char(64) NOT NULL,
	`country` char(2),
	`region` varchar(100),
	`city` varchar(100),
	`source` varchar(120),
	`device` enum('mobile','tablet','desktop') NOT NULL,
	`engaged_seconds` smallint unsigned,
	`scroll_depth` tinyint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `blog_post_views_id` PRIMARY KEY(`id`),
	CONSTRAINT `blog_post_views_view_uq` UNIQUE(`view_id`)
);
--> statement-breakpoint
ALTER TABLE `blog_post_views` ADD CONSTRAINT `blog_post_views_post_id_health_tips_id_fk` FOREIGN KEY (`post_id`) REFERENCES `health_tips`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `blog_post_views_post_created_idx` ON `blog_post_views` (`post_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `blog_post_views_created_idx` ON `blog_post_views` (`created_at`);