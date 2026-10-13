CREATE TABLE `hmo_applications` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`organisation` varchar(200) NOT NULL,
	`contact_name` varchar(200) NOT NULL,
	`contact_role` varchar(120),
	`email` varchar(191) NOT NULL,
	`phone` varchar(32),
	`enrollees` varchar(40),
	`services` json NOT NULL,
	`message` text,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`review_note` text,
	`reviewed_by` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`reviewed_at` datetime(3),
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_applications_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_applications_reviewed_by_admins_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `admins`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `hmo_applications_hmo_id_hmos_id_fk` FOREIGN KEY (`hmo_id`) REFERENCES `hmos`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_applications_status_idx` ON `hmo_applications` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `hmo_applications_email_idx` ON `hmo_applications` (`email`);
