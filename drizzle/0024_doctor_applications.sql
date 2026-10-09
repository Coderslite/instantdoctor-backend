ALTER TABLE `files`
  MODIFY COLUMN `owner_type` enum('user','admin','pharmacy','applicant') NOT NULL;
--> statement-breakpoint

CREATE TABLE `doctor_applications` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email` varchar(191) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `phone_number` varchar(32) NOT NULL,
  `gender` varchar(32),
  `date_of_birth` datetime(3),
  `country` varchar(64) NOT NULL,
  `state` varchar(64),
  `address` varchar(512),
  `specialization` varchar(128) NOT NULL,
  `experience_years` int NOT NULL,
  `licence_number` varchar(64) NOT NULL,
  `licensing_body` varchar(128) NOT NULL,
  `licence_expires_at` datetime(3),
  `institution` varchar(255) NOT NULL,
  `graduation_year` varchar(8) NOT NULL,
  `housemanship` varchar(255),
  `housemanship_year` varchar(8),
  `workplace` varchar(255),
  `languages` varchar(255),
  `bio` text,
  `documents` json NOT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `review_note` text,
  `reviewed_by` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
  `reviewed_at` datetime(3),
  `user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `doctor_applications_id` PRIMARY KEY(`id`),
  CONSTRAINT `doctor_applications_reviewed_by_admins_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `admins`(`id`) ON DELETE set null,
  CONSTRAINT `doctor_applications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `doctor_applications_status_idx` ON `doctor_applications` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `doctor_applications_email_idx` ON `doctor_applications` (`email`);
