ALTER TABLE `payments` MODIFY COLUMN `purpose` enum('appointment','order_checkout','lab_result','wallet_topup','family_subscription') NOT NULL;
--> statement-breakpoint
CREATE TABLE `family_subscriptions` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`status` enum('trialing','active','expired') NOT NULL DEFAULT 'trialing',
	`trial_started_at` datetime(3) NOT NULL,
	`trial_ends_at` datetime(3) NOT NULL,
	`current_period_start` datetime(3),
	`current_period_end` datetime(3),
	`consultation_credits_used` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `family_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `family_subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `family_subscriptions_user_uq` UNIQUE(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `is_subscription_credit` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `appointments` ADD `subscription_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin;
--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_subscription_id_family_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `family_subscriptions`(`id`) ON DELETE set null ON UPDATE no action;
