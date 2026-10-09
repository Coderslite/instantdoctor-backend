ALTER TABLE `pharmacies` ADD `cover_image` varchar(1024);--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `description` varchar(1000);--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `opening_hours` json;--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `time_zone` varchar(64) NOT NULL DEFAULT 'Africa/Lagos';--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `accepting_orders` boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `delivery_minutes` int NOT NULL DEFAULT 45;--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `rating_total` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `rating_count` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `pharmacies` ADD `live_at` datetime(3);--> statement-breakpoint
ALTER TABLE `pharmacies` ALTER COLUMN `status` SET DEFAULT 'onboarding';--> statement-breakpoint
UPDATE `pharmacies` SET `live_at` = `created_at` WHERE `status` = 'active';--> statement-breakpoint
ALTER TABLE `orders` ADD `eta_minutes` int;--> statement-breakpoint
ALTER TABLE `orders` ADD `rider_name` varchar(120);--> statement-breakpoint
ALTER TABLE `orders` ADD `rider_phone` varchar(32);--> statement-breakpoint
ALTER TABLE `orders` ADD `cancel_reason` varchar(255);--> statement-breakpoint
CREATE INDEX `orders_pharmacy_idx` ON `orders` (`pharmacy_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_events` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` varchar(32) NOT NULL,
  `actor` varchar(16) NOT NULL,
  `note` varchar(500),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `order_events_id` PRIMARY KEY(`id`),
  CONSTRAINT `order_events_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pharmacy_reviews` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `rating` int NOT NULL,
  `comment` text,
  `reply` text,
  `replied_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `pharmacy_reviews_id` PRIMARY KEY(`id`),
  CONSTRAINT `pharmacy_reviews_order_uq` UNIQUE(`order_id`),
  CONSTRAINT `pharmacy_reviews_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade,
  CONSTRAINT `pharmacy_reviews_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade,
  CONSTRAINT `pharmacy_reviews_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);--> statement-breakpoint
CREATE INDEX `pharmacy_reviews_pharmacy_idx` ON `pharmacy_reviews` (`pharmacy_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_issues` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category` enum('missing_item','wrong_item','damaged','late','not_delivered','quality','other') NOT NULL,
  `message` text NOT NULL,
  `status` enum('open','resolved') NOT NULL DEFAULT 'open',
  `response` text,
  `responded_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `order_issues_id` PRIMARY KEY(`id`),
  CONSTRAINT `order_issues_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade,
  CONSTRAINT `order_issues_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade,
  CONSTRAINT `order_issues_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);--> statement-breakpoint
CREATE INDEX `order_issues_pharmacy_idx` ON `order_issues` (`pharmacy_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_issues_order_idx` ON `order_issues` (`order_id`);
