CREATE TABLE `portal_sessions` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`subject_type` enum('admin','pharmacy') NOT NULL,
	`subject_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`family_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_agent` varchar(255),
	`expires_at` datetime(3) NOT NULL,
	`rotated_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `portal_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `portal_sessions_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `portal_sessions_family_idx` ON `portal_sessions` (`family_id`);--> statement-breakpoint
CREATE INDEX `portal_sessions_subject_idx` ON `portal_sessions` (`subject_type`,`subject_id`);