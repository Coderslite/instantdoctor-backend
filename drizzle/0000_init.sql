CREATE TABLE `admins` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`email` varchar(191) NOT NULL,
	`password_hash` varchar(255),
	`role` enum('admin','marketer') NOT NULL DEFAULT 'admin',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `admins_id` PRIMARY KEY(`id`),
	CONSTRAINT `admins_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `doctor_profiles` (
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`specialization` varchar(128),
	`experience_years` int,
	`bio` text,
	`is_available` boolean NOT NULL DEFAULT false,
	`working_hours` json,
	`certificate_url` varchar(1024),
	`institution` varchar(255),
	`graduation_year` varchar(8),
	`housemanship` varchar(255),
	`housemanship_year` varchar(8),
	`work_address` varchar(512),
	`home_address` varchar(512),
	`registered_on` varchar(16),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `doctor_profiles_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `payout_accounts` (
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`bank_name` varchar(128),
	`bank_code` varchar(32),
	`account_number` varchar(32),
	`account_name` varchar(255),
	`recipient_code` varchar(64),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payout_accounts_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `saved_locations` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`address` varchar(512) NOT NULL,
	`latitude` decimal(10,7) NOT NULL,
	`longitude` decimal(10,7) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `saved_locations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_medical_profiles` (
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`height` varchar(16),
	`weight` varchar(16),
	`blood_group` varchar(8),
	`genotype` varchar(8),
	`surgical_history` text,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_medical_profiles_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`email` varchar(191) NOT NULL,
	`password_hash` varchar(255),
	`legacy_auth` boolean NOT NULL DEFAULT false,
	`role` enum('user','doctor') NOT NULL DEFAULT 'user',
	`first_name` varchar(100) NOT NULL DEFAULT '',
	`last_name` varchar(100) NOT NULL DEFAULT '',
	`phone_number` varchar(32),
	`photo_url` varchar(1024),
	`gender` varchar(32),
	`date_of_birth` datetime(3),
	`marital_status` varchar(32),
	`state_of_origin` varchar(64),
	`other_language` varchar(255),
	`country` varchar(64),
	`currency` varchar(3),
	`platform` varchar(16),
	`address` varchar(512),
	`latitude` decimal(10,7),
	`longitude` decimal(10,7),
	`tag` varchar(64),
	`presence` varchar(16) NOT NULL DEFAULT 'offline',
	`last_seen_at` datetime(3),
	`fcm_token` varchar(512),
	`account_status` varchar(32),
	`is_trial_available` boolean NOT NULL DEFAULT true,
	`has_paid` boolean NOT NULL DEFAULT false,
	`wallet_balance` decimal(14,2) NOT NULL DEFAULT 0,
	`referral_balance` decimal(14,2) NOT NULL DEFAULT 0,
	`referral_enabled` boolean NOT NULL DEFAULT false,
	`referral_program_applied` boolean NOT NULL DEFAULT false,
	`referral_program_applied_at` datetime(3),
	`reminder_state` json,
	`email_verified_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_uq` UNIQUE(`email`),
	CONSTRAINT `users_tag_uq` UNIQUE(`tag`)
);
--> statement-breakpoint
CREATE TABLE `auth_identities` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`provider` enum('google','apple') NOT NULL,
	`provider_user_id` varchar(191) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `auth_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_identities_provider_uq` UNIQUE(`provider`,`provider_user_id`)
);
--> statement-breakpoint
CREATE TABLE `otp_codes` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`email` varchar(191) NOT NULL,
	`purpose` enum('register','login','password_reset') NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`expires_at` datetime(3) NOT NULL,
	`consumed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `otp_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`family_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_agent` varchar(255),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_tokens_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `appointment_charge_packages` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`currency` varchar(3) NOT NULL,
	`name` varchar(128) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`duration_seconds` int NOT NULL,
	`description` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `appointment_charge_packages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `appointment_messages` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`appointment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`sender_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`receiver_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` enum('text','image','file','voice') NOT NULL DEFAULT 'text',
	`status` enum('pending','sent','delivered','read','deleted') NOT NULL DEFAULT 'delivered',
	`message` text NOT NULL,
	`file_url` varchar(1024),
	`replied_to_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`replied_text` text,
	`replied_sender_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`is_edited` boolean NOT NULL DEFAULT false,
	`edited_at` datetime(3),
	`is_deleted` boolean NOT NULL DEFAULT false,
	`deleted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `appointment_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `appointment_packages` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`type` enum('basic','standard','special') NOT NULL,
	`amount_usd` decimal(14,2) NOT NULL,
	`list_amount_usd` decimal(14,2),
	`duration_seconds` int NOT NULL,
	`description` text,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `appointment_packages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`complaint` text,
	`symptoms` json NOT NULL,
	`status` enum('pending','active','completed','cancelled','deleted') NOT NULL DEFAULT 'pending',
	`package_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`package_label` varchar(128) NOT NULL,
	`package_type` enum('basic','standard','special'),
	`start_time` datetime(3) NOT NULL,
	`end_time` datetime(3) NOT NULL,
	`price` decimal(14,2) NOT NULL,
	`currency` varchar(3),
	`price_usd` decimal(14,2),
	`is_trial` boolean NOT NULL DEFAULT false,
	`is_paid` boolean NOT NULL DEFAULT false,
	`paid_at` datetime(3),
	`hold_expires_at` datetime(3),
	`doctor_earning` decimal(14,2),
	`idempotency_key` varchar(128),
	`reminder_count` int NOT NULL DEFAULT 0,
	`reminder_count_today` int NOT NULL DEFAULT 0,
	`last_reminder_sent_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `appointments_id` PRIMARY KEY(`id`),
	CONSTRAINT `appointments_idempotency_uq` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `prescriptions` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`appointment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`prescription` text NOT NULL,
	`seen` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `prescriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `report_messages` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`report_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`sender_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`receiver_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` enum('text','image','file','voice') NOT NULL DEFAULT 'text',
	`status` enum('pending','sent','delivered','read','deleted') NOT NULL DEFAULT 'delivered',
	`message` text NOT NULL,
	`file_url` varchar(1024),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `report_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`appointment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`subject` varchar(255) NOT NULL,
	`report` text NOT NULL,
	`status` enum('pending','in_progress','resolved','closed') NOT NULL DEFAULT 'pending',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `reports_appointment_uq` UNIQUE(`appointment_id`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`appointment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`doctor_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`rating` tinyint NOT NULL,
	`review` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `reviews_appointment_user_uq` UNIQUE(`appointment_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`scope` varchar(64) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`state` enum('in_progress','completed') NOT NULL DEFAULT 'in_progress',
	`response_status` int,
	`response_body` json,
	`locked_until` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `idempotency_keys_user_id_scope_idempotency_key_pk` PRIMARY KEY(`user_id`,`scope`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `payment_webhook_events` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`provider` enum('stripe','paystack','flutterwave') NOT NULL,
	`event_id` varchar(191) NOT NULL,
	`event_type` varchar(128) NOT NULL,
	`payment_reference` varchar(64),
	`payload` json NOT NULL,
	`processed_at` datetime(3),
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_webhook_events_uq` UNIQUE(`provider`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`reference` varchar(64) NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`purpose` enum('appointment','order_checkout','lab_result','wallet_topup') NOT NULL,
	`purpose_ref_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`provider` enum('stripe','paystack','flutterwave') NOT NULL,
	`status` enum('pending','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending',
	`base_amount` decimal(14,2) NOT NULL,
	`surcharge` decimal(14,2) NOT NULL DEFAULT 0,
	`amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`amount_minor` bigint NOT NULL,
	`provider_reference` varchar(128),
	`idempotency_key` varchar(128),
	`failure_reason` varchar(512),
	`metadata` json,
	`paid_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_reference_uq` UNIQUE(`reference`),
	CONSTRAINT `payments_idempotency_uq` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `wallet_transactions` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` enum('credit','debit') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'NGN',
	`title` varchar(255) NOT NULL,
	`balance_after` decimal(14,2),
	`payment_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`idempotency_key` varchar(128),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `wallet_transactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallet_transactions_idempotency_uq` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `withdrawals` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` varchar(32) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`bank_name` varchar(128),
	`bank_code` varchar(32),
	`account_number` varchar(32),
	`account_name` varchar(255),
	`recipient_code` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `withdrawals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_checkouts` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`subtotal` decimal(14,2) NOT NULL,
	`delivery_fee` decimal(14,2) NOT NULL,
	`total_amount` decimal(14,2) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`status` enum('awaiting_payment','paid','cancelled') NOT NULL DEFAULT 'awaiting_payment',
	`idempotency_key` varchar(128),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_checkouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_checkouts_idempotency_uq` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`product_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`name` varchar(255) NOT NULL,
	`unit_price` decimal(14,2) NOT NULL,
	`discount` int NOT NULL DEFAULT 0,
	`quantity` int NOT NULL,
	`image` varchar(1024),
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`checkout_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`tracking_id` varchar(16) NOT NULL,
	`status` enum('awaiting_payment','pending','processing','delivering','completed','cancelled') NOT NULL DEFAULT 'awaiting_payment',
	`subtotal` decimal(14,2) NOT NULL,
	`delivery_fee` decimal(14,2) NOT NULL,
	`total_amount` decimal(14,2) NOT NULL,
	`pharmacy_earning` decimal(14,2),
	`platform_earning` decimal(14,2),
	`address` varchar(512),
	`latitude` decimal(10,7),
	`longitude` decimal(10,7),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_tracking_uq` UNIQUE(`tracking_id`)
);
--> statement-breakpoint
CREATE TABLE `pharmacies` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(191) NOT NULL,
	`password_hash` varchar(255),
	`phone_number` varchar(32),
	`address` varchar(512),
	`latitude` decimal(10,7),
	`longitude` decimal(10,7),
	`delivery_fee_per_km` decimal(14,2) NOT NULL DEFAULT 0,
	`discount` int NOT NULL DEFAULT 0,
	`image` varchar(1024),
	`balance` decimal(14,2) NOT NULL DEFAULT 0,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pharmacies_id` PRIMARY KEY(`id`),
	CONSTRAINT `pharmacies_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `product_categories` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	CONSTRAINT `product_categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`category_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`name` varchar(255) NOT NULL,
	`description` text,
	`amount` decimal(14,2) NOT NULL,
	`purchase_price` decimal(14,2),
	`discount` int NOT NULL DEFAULT 0,
	`stock_remaining` int NOT NULL DEFAULT 0,
	`images` json NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `products_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lab_result_files` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`lab_result_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`file_url` varchar(1024) NOT NULL,
	`file_type` varchar(32) NOT NULL,
	CONSTRAINT `lab_result_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lab_results` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`status` enum('awaiting_payment','pending','completed') NOT NULL DEFAULT 'awaiting_payment',
	`price` decimal(14,2),
	`currency` varchar(3),
	`result_url` varchar(1024),
	`opened` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `lab_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `medication_doses` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`medication_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`dose_date` date NOT NULL,
	`dose_time` time,
	`status` enum('taken','missed') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `medication_doses_id` PRIMARY KEY(`id`),
	CONSTRAINT `medication_doses_slot_uq` UNIQUE(`medication_id`,`dose_date`,`dose_time`)
);
--> statement-breakpoint
CREATE TABLE `medications` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(255) NOT NULL,
	`prescription` text,
	`start_time` datetime(3) NOT NULL,
	`end_time` datetime(3) NOT NULL,
	`morning_time` time,
	`midday_time` time,
	`evening_time` time,
	`interval_hours` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `medications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_questions` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`status` enum('pending','completed') NOT NULL DEFAULT 'pending',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `anonymous_questions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `health_tip_categories` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`name` varchar(128) NOT NULL,
	`image` varchar(1024),
	CONSTRAINT `health_tip_categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `health_tip_likes` (
	`health_tip_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `health_tip_likes_health_tip_id_user_id_pk` PRIMARY KEY(`health_tip_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `health_tip_views` (
	`health_tip_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `health_tip_views_health_tip_id_user_id_pk` PRIMARY KEY(`health_tip_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `health_tips` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`category_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`title` varchar(255) NOT NULL,
	`slug` varchar(255),
	`description` longtext NOT NULL,
	`image` varchar(1024),
	`type` varchar(32) NOT NULL DEFAULT 'article',
	`views` int NOT NULL DEFAULT 0,
	`is_sent` boolean NOT NULL DEFAULT false,
	`published_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `health_tips_id` PRIMARY KEY(`id`),
	CONSTRAINT `health_tips_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` enum('chat','transaction','appointment','medication','call','lab_result') NOT NULL,
	`title` varchar(512) NOT NULL,
	`unique_id` varchar(128),
	`status` enum('delivered','read') NOT NULL DEFAULT 'delivered',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`referrer_tag` varchar(64) NOT NULL,
	`referrer_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`signup_bonus_paid` boolean NOT NULL DEFAULT false,
	`total_commission_earned` decimal(14,2) NOT NULL DEFAULT 0,
	`last_commission_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `referrals_user_uq` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `waitlist_entries` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`address` varchar(512) NOT NULL,
	`latitude` decimal(10,7) NOT NULL,
	`longitude` decimal(10,7) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `waitlist_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `app_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `currencies` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`code` varchar(3) NOT NULL,
	CONSTRAINT `currencies_id` PRIMARY KEY(`id`),
	CONSTRAINT `currencies_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `service_charges` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`type` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`amount_usd` decimal(14,2) NOT NULL,
	`legacy_price_ngn` decimal(14,2),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `service_charges_id` PRIMARY KEY(`id`),
	CONSTRAINT `service_charges_type_uq` UNIQUE(`type`)
);
--> statement-breakpoint
CREATE TABLE `video_call_credentials` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`provider` varchar(32) NOT NULL DEFAULT 'zegocloud',
	`app_id` bigint NOT NULL,
	`app_sign` varchar(255) NOT NULL,
	`in_use` boolean NOT NULL DEFAULT false,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `video_call_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `doctor_profiles` ADD CONSTRAINT `doctor_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payout_accounts` ADD CONSTRAINT `payout_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saved_locations` ADD CONSTRAINT `saved_locations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_medical_profiles` ADD CONSTRAINT `user_medical_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_identities` ADD CONSTRAINT `auth_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_messages` ADD CONSTRAINT `appointment_messages_appointment_id_appointments_id_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_doctor_id_users_id_fk` FOREIGN KEY (`doctor_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_package_id_appointment_packages_id_fk` FOREIGN KEY (`package_id`) REFERENCES `appointment_packages`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_appointment_id_appointments_id_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_messages` ADD CONSTRAINT `report_messages_report_id_reports_id_fk` FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_appointment_id_appointments_id_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_appointment_id_appointments_id_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_doctor_id_users_id_fk` FOREIGN KEY (`doctor_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `withdrawals` ADD CONSTRAINT `withdrawals_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_checkouts` ADD CONSTRAINT `order_checkouts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_checkout_id_order_checkouts_id_fk` FOREIGN KEY (`checkout_id`) REFERENCES `order_checkouts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_product_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lab_result_files` ADD CONSTRAINT `lab_result_files_lab_result_id_lab_results_id_fk` FOREIGN KEY (`lab_result_id`) REFERENCES `lab_results`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lab_results` ADD CONSTRAINT `lab_results_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `medication_doses` ADD CONSTRAINT `medication_doses_medication_id_medications_id_fk` FOREIGN KEY (`medication_id`) REFERENCES `medications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `medications` ADD CONSTRAINT `medications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `anonymous_questions` ADD CONSTRAINT `anonymous_questions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `health_tip_likes` ADD CONSTRAINT `health_tip_likes_health_tip_id_health_tips_id_fk` FOREIGN KEY (`health_tip_id`) REFERENCES `health_tips`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `health_tip_likes` ADD CONSTRAINT `health_tip_likes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `health_tip_views` ADD CONSTRAINT `health_tip_views_health_tip_id_health_tips_id_fk` FOREIGN KEY (`health_tip_id`) REFERENCES `health_tips`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `health_tip_views` ADD CONSTRAINT `health_tip_views_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `health_tips` ADD CONSTRAINT `health_tips_category_id_health_tip_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `health_tip_categories`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_referrer_id_users_id_fk` FOREIGN KEY (`referrer_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waitlist_entries` ADD CONSTRAINT `waitlist_entries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `doctor_profiles_available_idx` ON `doctor_profiles` (`is_available`);--> statement-breakpoint
CREATE INDEX `saved_locations_user_idx` ON `saved_locations` (`user_id`);--> statement-breakpoint
CREATE INDEX `users_role_presence_idx` ON `users` (`role`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `auth_identities_user_idx` ON `auth_identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `otp_codes_lookup_idx` ON `otp_codes` (`email`,`purpose`,`created_at`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_family_idx` ON `refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `appointment_charge_packages_currency_idx` ON `appointment_charge_packages` (`currency`);--> statement-breakpoint
CREATE INDEX `appointment_messages_thread_idx` ON `appointment_messages` (`appointment_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `appointment_messages_unread_idx` ON `appointment_messages` (`appointment_id`,`sender_id`,`status`);--> statement-breakpoint
CREATE INDEX `appointments_doctor_time_idx` ON `appointments` (`doctor_id`,`start_time`,`end_time`);--> statement-breakpoint
CREATE INDEX `appointments_user_updated_idx` ON `appointments` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `appointments_user_paid_idx` ON `appointments` (`user_id`,`is_paid`);--> statement-breakpoint
CREATE INDEX `prescriptions_appointment_idx` ON `prescriptions` (`appointment_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `report_messages_thread_idx` ON `report_messages` (`report_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_user_updated_idx` ON `reports` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `reviews_doctor_idx` ON `reviews` (`doctor_id`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `payments_purpose_idx` ON `payments` (`purpose`,`purpose_ref_id`);--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_provider_ref_idx` ON `payments` (`provider`,`provider_reference`);--> statement-breakpoint
CREATE INDEX `wallet_transactions_user_idx` ON `wallet_transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `withdrawals_user_idx` ON `withdrawals` (`user_id`);--> statement-breakpoint
CREATE INDEX `order_checkouts_user_idx` ON `order_checkouts` (`user_id`);--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_checkout_idx` ON `orders` (`checkout_id`);--> statement-breakpoint
CREATE INDEX `pharmacies_status_idx` ON `pharmacies` (`status`);--> statement-breakpoint
CREATE INDEX `products_pharmacy_idx` ON `products` (`pharmacy_id`,`status`);--> statement-breakpoint
CREATE INDEX `lab_result_files_result_idx` ON `lab_result_files` (`lab_result_id`);--> statement-breakpoint
CREATE INDEX `lab_results_user_idx` ON `lab_results` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `medications_user_idx` ON `medications` (`user_id`);--> statement-breakpoint
CREATE INDEX `anonymous_questions_user_idx` ON `anonymous_questions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `health_tips_category_published_idx` ON `health_tips` (`category_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `referrals_referrer_idx` ON `referrals` (`referrer_tag`,`created_at`);--> statement-breakpoint
CREATE INDEX `waitlist_entries_user_idx` ON `waitlist_entries` (`user_id`);