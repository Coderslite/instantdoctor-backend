ALTER TABLE `hmo_plans` ADD `payment_model` enum('fee_for_service','capitation') NOT NULL DEFAULT 'fee_for_service';
--> statement-breakpoint
ALTER TABLE `hmo_plans` ADD `capitation_rate` decimal(14,2);
--> statement-breakpoint
ALTER TABLE `hmo_plan_rules` ADD `billing` enum('per_use','capitation') NOT NULL DEFAULT 'per_use';
--> statement-breakpoint
ALTER TABLE `hmo_claims` ADD `billing` enum('per_use','capitation') NOT NULL DEFAULT 'per_use';
--> statement-breakpoint
ALTER TABLE `hmo_enrollees` ADD `deactivated_at` datetime(3);
--> statement-breakpoint
UPDATE `hmo_enrollees` SET `deactivated_at` = `updated_at` WHERE `status` <> 'active';
--> statement-breakpoint
ALTER TABLE `hmo_invoices` ADD `capitation_amount` decimal(14,2) NOT NULL DEFAULT '0';
--> statement-breakpoint
CREATE TABLE `hmo_capitation_lines` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`invoice_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`hmo_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`plan_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`month` char(7) NOT NULL,
	`members` int NOT NULL,
	`rate` decimal(14,2) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `hmo_capitation_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `hmo_capitation_lines_plan_month_uq` UNIQUE(`plan_id`,`month`),
	CONSTRAINT `hmo_capitation_lines_invoice_id_hmo_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `hmo_invoices`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `hmo_capitation_lines_plan_id_hmo_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `hmo_plans`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `hmo_capitation_lines_invoice_idx` ON `hmo_capitation_lines` (`invoice_id`);
