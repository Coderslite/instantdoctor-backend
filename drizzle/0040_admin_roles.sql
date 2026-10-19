ALTER TABLE `admins` MODIFY COLUMN `role` enum('admin','operations','finance','clinical','support','marketer') NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE `admins` ADD `status` enum('active','inactive') DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `admins` ADD `must_change_password` boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `admins` ADD `last_login_at` datetime(3);
