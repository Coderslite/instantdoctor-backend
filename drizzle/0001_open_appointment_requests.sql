ALTER TABLE `appointments` MODIFY COLUMN `doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
ALTER TABLE `reports` MODIFY COLUMN `doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;--> statement-breakpoint
CREATE INDEX `appointments_open_idx` ON `appointments` (`status`,`doctor_id`,`start_time`);