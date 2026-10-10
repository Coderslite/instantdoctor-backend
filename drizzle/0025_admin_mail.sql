CREATE TABLE `admin_emails` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`reference` varchar(32) NOT NULL,
	`admin_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`subject` varchar(200) NOT NULL,
	`body` longtext NOT NULL,
	`signature_name` varchar(128) NOT NULL,
	`signature_title` varchar(128),
	`audience` json NOT NULL,
	`status` enum('sending','sent','partial','failed') NOT NULL DEFAULT 'sending',
	`recipient_count` int NOT NULL DEFAULT 0,
	`sent_count` int NOT NULL DEFAULT 0,
	`failed_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `admin_emails_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_emails_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `admin_emails_created_idx` ON `admin_emails` (`created_at`);
--> statement-breakpoint
CREATE TABLE `admin_email_recipients` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`email_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`email` varchar(191) NOT NULL,
	`name` varchar(200),
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`status` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
	`error` text,
	`sent_at` datetime(3),
	CONSTRAINT `admin_email_recipients_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_email_recipients_email_id_admin_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `admin_emails`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `admin_email_recipients_email_idx` ON `admin_email_recipients` (`email_id`,`status`);
