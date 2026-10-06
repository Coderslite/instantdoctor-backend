CREATE TABLE `files` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`purpose` varchar(48) NOT NULL,
	`visibility` enum('public','private') NOT NULL,
	`owner_type` enum('user','admin','pharmacy') NOT NULL,
	`owner_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`storage_key` varchar(512) NOT NULL,
	`content_type` varchar(128) NOT NULL,
	`size_bytes` int NOT NULL,
	`original_name` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `files_id` PRIMARY KEY(`id`),
	CONSTRAINT `files_storage_key_uq` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE INDEX `files_owner_idx` ON `files` (`owner_type`,`owner_id`,`purpose`);