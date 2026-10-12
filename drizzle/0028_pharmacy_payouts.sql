CREATE TABLE `pharmacy_ledger` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` enum('order_earning','order_reversal','payout','payout_reversal','adjustment') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`balance_after` decimal(14,2) NOT NULL,
	`description` varchar(255) NOT NULL,
	`order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`payout_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_by` varchar(255),
	`available_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pharmacy_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `pharmacy_ledger_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `pharmacy_ledger_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `pharmacy_ledger_pharmacy_idx` ON `pharmacy_ledger` (`pharmacy_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pharmacy_ledger_order_idx` ON `pharmacy_ledger` (`order_id`);
--> statement-breakpoint
CREATE INDEX `pharmacy_ledger_payout_idx` ON `pharmacy_ledger` (`payout_id`);
--> statement-breakpoint
CREATE TABLE `pharmacy_bank_accounts` (
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`bank_code` varchar(32) NOT NULL,
	`bank_name` varchar(128) NOT NULL,
	`account_number` varchar(20) NOT NULL,
	`account_name` varchar(255) NOT NULL,
	`recipient_code` varchar(64) NOT NULL,
	`updated_by` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pharmacy_bank_accounts_pharmacy_id` PRIMARY KEY(`pharmacy_id`),
	CONSTRAINT `pharmacy_bank_accounts_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE `pharmacy_payouts` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`reference` varchar(50) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'NGN',
	`trigger` enum('on_demand','scheduled') NOT NULL,
	`status` enum('pending_approval','processing','paid','failed','rejected','cancelled') NOT NULL DEFAULT 'pending_approval',
	`bank_name` varchar(128) NOT NULL,
	`account_number` varchar(20) NOT NULL,
	`account_name` varchar(255) NOT NULL,
	`recipient_code` varchar(64) NOT NULL,
	`requested_by` varchar(255) NOT NULL,
	`approved_by` varchar(255),
	`approved_at` datetime(3),
	`transfer_code` varchar(64),
	`rejection_reason` varchar(500),
	`last_error` varchar(500),
	`paid_at` datetime(3),
	`run_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pharmacy_payouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `pharmacy_payouts_reference_uq` UNIQUE(`reference`),
	CONSTRAINT `pharmacy_payouts_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `pharmacy_payouts_pharmacy_idx` ON `pharmacy_payouts` (`pharmacy_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pharmacy_payouts_status_idx` ON `pharmacy_payouts` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `pharmacy_payout_runs` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`run_key` varchar(64) NOT NULL,
	`started_by` varchar(255) NOT NULL,
	`payout_count` int NOT NULL DEFAULT 0,
	`total_amount` decimal(14,2) NOT NULL DEFAULT 0,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pharmacy_payout_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `pharmacy_payout_runs_key_uq` UNIQUE(`run_key`)
);
--> statement-breakpoint
-- Earnings are tracked from this moment on; older completed orders are settled by admin adjustment.
INSERT INTO `app_settings` (`key`, `value`) VALUES ('pharmacy_ledger_started_at', CAST(CONCAT('"', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'), '"') AS JSON)) ON DUPLICATE KEY UPDATE `key` = `key`;
