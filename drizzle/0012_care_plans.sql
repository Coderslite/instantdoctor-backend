CREATE TABLE `care_plans` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`user_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`kind` enum('hypertension','diabetes','general') NOT NULL,
	`name` varchar(120) NOT NULL,
	`notes` text,
	`next_review_at` datetime(3),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `care_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `care_plans_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `care_plans_user_active_idx` ON `care_plans` (`user_id`,`is_active`);
--> statement-breakpoint
CREATE TABLE `vital_readings` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`care_plan_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`systolic` int,
	`diastolic` int,
	`glucose` int,
	`measured_at` datetime(3) NOT NULL,
	`note` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `vital_readings_id` PRIMARY KEY(`id`),
	CONSTRAINT `vital_readings_care_plan_id_care_plans_id_fk` FOREIGN KEY (`care_plan_id`) REFERENCES `care_plans`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `vital_readings_plan_measured_idx` ON `vital_readings` (`care_plan_id`,`measured_at`);
