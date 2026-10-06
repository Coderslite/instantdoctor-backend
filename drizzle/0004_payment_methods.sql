ALTER TABLE `payments` ADD `method` enum('card','bank_transfer') DEFAULT 'card' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `payments` ADD `customer_confirmed_at` datetime(3);