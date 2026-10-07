-- Some databases recorded 0012 after 0013's original timestamp, causing 0013
-- to be skipped. This migration completes the family-care schema safely.
CREATE TABLE IF NOT EXISTS `family_profiles` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`owner_user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(80) NOT NULL,
	`relationship` enum('spouse','child','parent','sibling','grandparent','other') NOT NULL,
	`date_of_birth` date,
	`sex` enum('male','female'),
	`blood_group` varchar(8),
	`genotype` varchar(8),
	`allergies` text,
	`conditions` text,
	`caregiver_reminders` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `family_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `family_profiles_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `care_summary_shares` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`owner_user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`profile_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`view_count` int NOT NULL DEFAULT 0,
	`last_viewed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `care_summary_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `care_summary_shares_token_uq` UNIQUE(`token_hash`),
	CONSTRAINT `care_summary_shares_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `care_summary_shares_profile_id_family_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `family_profiles`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
SET @care_plans_profile_id_sql = IF(
	EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'care_plans' AND column_name = 'profile_id'),
	'SELECT 1',
	'ALTER TABLE `care_plans` ADD COLUMN `profile_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin'
);
--> statement-breakpoint
PREPARE care_plans_profile_id_statement FROM @care_plans_profile_id_sql;
--> statement-breakpoint
EXECUTE care_plans_profile_id_statement;
--> statement-breakpoint
DEALLOCATE PREPARE care_plans_profile_id_statement;
--> statement-breakpoint
SET @medications_profile_id_sql = IF(
	EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'medications' AND column_name = 'profile_id'),
	'SELECT 1',
	'ALTER TABLE `medications` ADD COLUMN `profile_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin'
);
--> statement-breakpoint
PREPARE medications_profile_id_statement FROM @medications_profile_id_sql;
--> statement-breakpoint
EXECUTE medications_profile_id_statement;
--> statement-breakpoint
DEALLOCATE PREPARE medications_profile_id_statement;
