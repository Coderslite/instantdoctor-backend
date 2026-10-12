CREATE TABLE `hmo_users` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(200) NOT NULL,
	`email` varchar(191) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('admin','manager','viewer') NOT NULL DEFAULT 'viewer',
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`must_change_password` boolean NOT NULL DEFAULT true,
	`session_version` int NOT NULL DEFAULT 0,
	`last_login_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_users_email_uq` UNIQUE(`email`),
	CONSTRAINT `hmo_users_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_users_hmo_idx` ON `hmo_users` (`hmo_id`,`status`);
--> statement-breakpoint
CREATE TABLE `hmo_activity` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`actor_type` enum('hmo_user','admin','system') NOT NULL,
	`actor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`actor_name` varchar(200) NOT NULL,
	`action` varchar(64) NOT NULL,
	`entity_type` varchar(32),
	`entity_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`summary` varchar(500) NOT NULL,
	`details` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_activity_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_activity_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_activity_hmo_idx` ON `hmo_activity` (`hmo_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `hmo_activity_entity_idx` ON `hmo_activity` (`hmo_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
ALTER TABLE `portal_sessions`
  MODIFY `subject_type` enum('admin','pharmacy','pharmacy_staff','hmo_user') NOT NULL;
