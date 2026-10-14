CREATE TABLE `doctor_ledger` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` enum('earning','earning_reversal','payout','payout_reversal','adjustment') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`description` varchar(255) NOT NULL,
	`appointment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`payout_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_by` varchar(255),
	`available_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `doctor_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `doctor_ledger_doctor_id_users_id_fk` FOREIGN KEY (`doctor_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `doctor_ledger_doctor_idx` ON `doctor_ledger` (`doctor_id`,`currency`,`created_at`);
--> statement-breakpoint
CREATE INDEX `doctor_ledger_appointment_idx` ON `doctor_ledger` (`appointment_id`);
--> statement-breakpoint
CREATE INDEX `doctor_ledger_payout_idx` ON `doctor_ledger` (`payout_id`);
--> statement-breakpoint
CREATE TABLE `doctor_payouts` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`reference` varchar(50) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`method` enum('paystack','manual') NOT NULL,
	`trigger` enum('on_demand','scheduled') NOT NULL,
	`status` enum('pending_approval','processing','paid','failed','rejected','cancelled') NOT NULL DEFAULT 'pending_approval',
	`bank_name` varchar(128) NOT NULL,
	`account_number` varchar(32) NOT NULL,
	`account_name` varchar(255) NOT NULL,
	`recipient_code` varchar(64),
	`requested_by` varchar(255) NOT NULL,
	`approved_by` varchar(255),
	`approved_at` datetime(3),
	`transfer_code` varchar(64),
	`payment_reference` varchar(120),
	`rejection_reason` varchar(500),
	`last_error` varchar(500),
	`paid_at` datetime(3),
	`run_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `doctor_payouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `doctor_payouts_reference_uq` UNIQUE(`reference`),
	CONSTRAINT `doctor_payouts_doctor_id_users_id_fk` FOREIGN KEY (`doctor_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `doctor_payouts_doctor_idx` ON `doctor_payouts` (`doctor_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `doctor_payouts_status_idx` ON `doctor_payouts` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `doctor_payout_runs` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`run_key` varchar(64) NOT NULL,
	`started_by` varchar(255) NOT NULL,
	`payout_count` int NOT NULL DEFAULT 0,
	`totals` json,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `doctor_payout_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `doctor_payout_runs_key_uq` UNIQUE(`run_key`)
);
