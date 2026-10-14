ALTER TABLE `hmo_plan_rules` ADD `authorization_above` decimal(14,2);
--> statement-breakpoint
ALTER TABLE `hmo_claims` ADD `authorization_code` varchar(40);
--> statement-breakpoint
CREATE TABLE `hmo_authorizations` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`plan_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`rule_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`enrollee_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`service` enum('consultation','lab_interpretation','medicines') NOT NULL,
	`package_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`description` varchar(255) NOT NULL,
	`patient_note` varchar(1000),
	`standard_amount` decimal(14,2) NOT NULL,
	`requested_amount` decimal(14,2) NOT NULL,
	`approved_amount` decimal(14,2),
	`status` enum('pending','approved','rejected','cancelled','used') NOT NULL DEFAULT 'pending',
	`code` varchar(40),
	`hmo_reference` varchar(80),
	`decision_note` varchar(500),
	`decided_by` varchar(200),
	`decided_at` datetime(3),
	`expires_at` datetime(3),
	`claim_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_authorizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_authorizations_code_uq` UNIQUE(`code`),
	CONSTRAINT `hmo_authorizations_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_authorizations_enrollee_id_hmo_enrollees_id_fk` FOREIGN KEY (`enrollee_id`) REFERENCES `hmo_enrollees`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_authorizations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_authorizations_hmo_idx` ON `hmo_authorizations` (`hmo_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `hmo_authorizations_enrollee_idx` ON `hmo_authorizations` (`enrollee_id`,`service`,`status`);
