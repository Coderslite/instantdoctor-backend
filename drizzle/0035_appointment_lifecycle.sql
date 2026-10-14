ALTER TABLE `appointments` ADD `completed_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `completed_by` varchar(16);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `doctor_joined_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `patient_joined_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `completion_reminded_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `needs_review_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `review_reason` varchar(32);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `refunded_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `refunded_amount` decimal(14,2);
--> statement-breakpoint
CREATE INDEX `appointments_lifecycle_idx` ON `appointments` (`status`,`end_time`);
--> statement-breakpoint
CREATE INDEX `appointments_review_idx` ON `appointments` (`needs_review_at`);
