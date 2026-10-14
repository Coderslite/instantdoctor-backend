CREATE TABLE `pharmacy_applications` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`pharmacy_name` varchar(255) NOT NULL,
	`contact_name` varchar(200) NOT NULL,
	`contact_role` varchar(120),
	`email` varchar(191) NOT NULL,
	`phone` varchar(32) NOT NULL,
	`address` varchar(512) NOT NULL,
	`city` varchar(120),
	`state` varchar(120),
	`licence_number` varchar(80),
	`branches` varchar(40),
	`offers_delivery` boolean NOT NULL DEFAULT false,
	`message` text,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`review_note` text,
	`reviewed_by` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`reviewed_at` datetime(3),
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pharmacy_applications_id` PRIMARY KEY(`id`),
	CONSTRAINT `pharmacy_applications_reviewed_by_admins_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `admins`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `pharmacy_applications_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `pharmacy_applications_status_idx` ON `pharmacy_applications` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pharmacy_applications_email_idx` ON `pharmacy_applications` (`email`);
--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `must_change_password` boolean DEFAULT false NOT NULL;
