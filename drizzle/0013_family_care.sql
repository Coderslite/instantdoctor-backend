CREATE TABLE `care_summary_shares` (
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
	CONSTRAINT `care_summary_shares_token_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `family_profiles` (
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
	CONSTRAINT `family_profiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `care_plans` ADD `profile_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `medications` ADD `profile_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `care_summary_shares` ADD CONSTRAINT `care_summary_shares_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `care_summary_shares` ADD CONSTRAINT `care_summary_shares_profile_id_family_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `family_profiles`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `family_profiles` ADD CONSTRAINT `family_profiles_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `care_summary_shares_owner_idx` ON `care_summary_shares` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `family_profiles_owner_idx` ON `family_profiles` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `care_plans` ADD CONSTRAINT `care_plans_profile_id_family_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `family_profiles`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `medications` ADD CONSTRAINT `medications_profile_id_family_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `family_profiles`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `care_plans_profile_idx` ON `care_plans` (`profile_id`);--> statement-breakpoint
CREATE INDEX `medications_profile_idx` ON `medications` (`profile_id`);