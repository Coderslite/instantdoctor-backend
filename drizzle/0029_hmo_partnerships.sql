CREATE TABLE `hmos` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(200) NOT NULL,
	`code` varchar(20) NOT NULL,
	`logo` varchar(1024),
	`contact_name` varchar(200),
	`contact_email` varchar(191),
	`contact_phone` varchar(32),
	`address` varchar(500),
	`status` enum('active','paused','ended') NOT NULL DEFAULT 'active',
	`payment_terms_days` int NOT NULL DEFAULT 30,
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmos_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmos_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `hmo_plans` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(120) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`valid_from` datetime(3),
	`valid_to` datetime(3),
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_plans_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_plans_hmo_idx` ON `hmo_plans` (`hmo_id`);
--> statement-breakpoint
CREATE TABLE `hmo_plan_rules` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`plan_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`service` enum('consultation','lab_interpretation') NOT NULL,
	`package_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`coverage` enum('full','copay_fixed','copay_percent','discount_percent','fixed_price','not_covered') NOT NULL,
	`patient_amount` decimal(14,2),
	`percent` decimal(5,2),
	`hmo_amount` decimal(14,2),
	`doctor_earning` decimal(14,2),
	`limit_count` int,
	`limit_period` enum('month','year','contract'),
	`over_limit` enum('standard_price','block') NOT NULL DEFAULT 'standard_price',
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_plan_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_plan_rules_plan_id_hmo_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `hmo_plans`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_plan_rules_package_id_appointment_packages_id_fk` FOREIGN KEY (`package_id`) REFERENCES `appointment_packages`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_plan_rules_plan_idx` ON `hmo_plan_rules` (`plan_id`,`service`);
--> statement-breakpoint
CREATE TABLE `hmo_enrollees` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`plan_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`enrollee_code` varchar(64) NOT NULL,
	`first_name` varchar(100),
	`last_name` varchar(100),
	`phone` varchar(32),
	`email` varchar(191),
	`date_of_birth` varchar(10),
	`status` enum('active','suspended','ended') NOT NULL DEFAULT 'active',
	`valid_from` datetime(3),
	`valid_to` datetime(3),
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`linked_at` datetime(3),
	`link_method` enum('admin','match','self'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_enrollees_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_enrollees_code_uq` UNIQUE(`hmo_id`,`enrollee_code`),
	CONSTRAINT `hmo_enrollees_user_uq` UNIQUE(`user_id`),
	CONSTRAINT `hmo_enrollees_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_enrollees_plan_id_hmo_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `hmo_plans`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `hmo_enrollees_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_enrollees_phone_idx` ON `hmo_enrollees` (`phone`);
--> statement-breakpoint
CREATE INDEX `hmo_enrollees_email_idx` ON `hmo_enrollees` (`email`);
--> statement-breakpoint
CREATE TABLE `hmo_link_requests` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`enrollee_code` varchar(64) NOT NULL,
	`reason` varchar(32) NOT NULL,
	`details` json,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reviewed_by` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`reviewed_at` datetime(3),
	`review_note` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_link_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_link_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_link_requests_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_link_requests_reviewed_by_admins_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `admins`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_link_requests_status_idx` ON `hmo_link_requests` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `hmo_claims` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`plan_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`enrollee_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`rule_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`service` enum('consultation','lab_interpretation') NOT NULL,
	`appointment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`lab_result_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`description` varchar(255) NOT NULL,
	`enrollee_code` varchar(64) NOT NULL,
	`coverage` enum('full','copay_fixed','copay_percent','discount_percent','fixed_price','not_covered') NOT NULL,
	`standard_amount` decimal(14,2) NOT NULL,
	`patient_amount` decimal(14,2) NOT NULL,
	`hmo_amount` decimal(14,2) NOT NULL,
	`doctor_earning` decimal(14,2),
	`currency` varchar(3) NOT NULL DEFAULT 'NGN',
	`status` enum('unbilled','invoiced','paid','rejected','void') NOT NULL DEFAULT 'unbilled',
	`invoice_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`status_note` varchar(500),
	`service_date` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_claims_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `hmo_claims_plan_id_hmo_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `hmo_plans`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `hmo_claims_enrollee_id_hmo_enrollees_id_fk` FOREIGN KEY (`enrollee_id`) REFERENCES `hmo_enrollees`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `hmo_claims_rule_id_hmo_plan_rules_id_fk` FOREIGN KEY (`rule_id`) REFERENCES `hmo_plan_rules`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `hmo_claims_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_claims_hmo_status_idx` ON `hmo_claims` (`hmo_id`,`status`,`service_date`);
--> statement-breakpoint
CREATE INDEX `hmo_claims_enrollee_idx` ON `hmo_claims` (`enrollee_id`,`rule_id`,`service_date`);
--> statement-breakpoint
CREATE INDEX `hmo_claims_appointment_idx` ON `hmo_claims` (`appointment_id`);
--> statement-breakpoint
CREATE INDEX `hmo_claims_invoice_idx` ON `hmo_claims` (`invoice_id`);
--> statement-breakpoint
CREATE TABLE `hmo_invoices` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`reference` varchar(40) NOT NULL,
	`period_start` datetime(3) NOT NULL,
	`period_end` datetime(3) NOT NULL,
	`claim_count` int NOT NULL,
	`total_amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'NGN',
	`status` enum('issued','paid','cancelled') NOT NULL DEFAULT 'issued',
	`due_at` datetime(3) NOT NULL,
	`paid_at` datetime(3),
	`payment_reference` varchar(120),
	`notes` text,
	`created_by` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_invoices_reference_uq` UNIQUE(`reference`),
	CONSTRAINT `hmo_invoices_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `hmo_invoices_created_by_admins_id_fk` FOREIGN KEY (`created_by`) REFERENCES `admins`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_invoices_hmo_idx` ON `hmo_invoices` (`hmo_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `hmo_claim_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;
