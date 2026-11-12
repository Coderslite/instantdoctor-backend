CREATE TABLE `download_clicks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`click_id` char(36) NOT NULL,
	`store` enum('android','ios') NOT NULL,
	`source` varchar(120),
	`medium` varchar(100),
	`campaign` varchar(191),
	`campaign_id` varchar(100),
	`referrer` varchar(255),
	`page` varchar(255),
	`device` enum('mobile','tablet','desktop') NOT NULL,
	`os` enum('android','ios','windows','mac','linux','other') NOT NULL,
	`country` char(2),
	`region` varchar(100),
	`city` varchar(100),
	`visitor_hash` char(64) NOT NULL,
	`user_agent` varchar(500),
	`legacy_id` int unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `download_clicks_id` PRIMARY KEY(`id`),
	CONSTRAINT `download_clicks_click_uq` UNIQUE(`click_id`),
	CONSTRAINT `download_clicks_legacy_uq` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE INDEX `download_clicks_created_idx` ON `download_clicks` (`created_at`);--> statement-breakpoint
CREATE INDEX `download_clicks_source_created_idx` ON `download_clicks` (`source`,`created_at`);
