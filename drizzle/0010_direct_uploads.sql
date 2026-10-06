ALTER TABLE `files` ADD `status` enum('pending','ready') DEFAULT 'ready' NOT NULL;--> statement-breakpoint
CREATE INDEX `files_status_created_idx` ON `files` (`status`,`created_at`);