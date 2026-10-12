ALTER TABLE `prescriptions` ADD `code` varchar(16);
--> statement-breakpoint
ALTER TABLE `prescriptions` ADD `notes` text;
--> statement-breakpoint
ALTER TABLE `prescriptions` ADD `expires_at` datetime(3);
--> statement-breakpoint
CREATE UNIQUE INDEX `prescriptions_code_uq` ON `prescriptions` (`code`);
--> statement-breakpoint
CREATE INDEX `prescriptions_user_idx` ON `prescriptions` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `prescription_items` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`prescription_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(200) NOT NULL,
	`strength` varchar(60),
	`form` varchar(40),
	`directions` varchar(500) NOT NULL,
	`duration_days` int,
	`quantity` int NOT NULL DEFAULT 1,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `prescription_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `prescription_items_prescription_id_prescriptions_id_fk` FOREIGN KEY (`prescription_id`) REFERENCES `prescriptions`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `prescription_items_prescription_idx` ON `prescription_items` (`prescription_id`,`sort_order`);
--> statement-breakpoint
ALTER TABLE `order_items` ADD `prescription_item_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;
--> statement-breakpoint
CREATE INDEX `order_items_prescription_item_idx` ON `order_items` (`prescription_item_id`);
--> statement-breakpoint
ALTER TABLE `orders` ADD `prescription_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;
--> statement-breakpoint
ALTER TABLE `orders` ADD `hmo_amount` decimal(14,2) NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE `orders` ADD `hmo_claim_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;
--> statement-breakpoint
ALTER TABLE `order_checkouts` ADD `hmo_amount` decimal(14,2) NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE `hmo_plan_rules` MODIFY COLUMN `service` enum('consultation','lab_interpretation','medicines') NOT NULL;
--> statement-breakpoint
ALTER TABLE `hmo_plan_rules` ADD `limit_amount` decimal(14,2);
--> statement-breakpoint
ALTER TABLE `hmo_claims` MODIFY COLUMN `service` enum('consultation','lab_interpretation','medicines') NOT NULL;
--> statement-breakpoint
ALTER TABLE `hmo_claims` ADD `order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;
--> statement-breakpoint
CREATE INDEX `hmo_claims_order_idx` ON `hmo_claims` (`order_id`);
