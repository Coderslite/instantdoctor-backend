ALTER TABLE `lab_results` ADD `test_name` varchar(255);--> statement-breakpoint
ALTER TABLE `lab_results` ADD `laboratory_name` varchar(255);--> statement-breakpoint
ALTER TABLE `lab_results` ADD `reference_number` varchar(128);--> statement-breakpoint
ALTER TABLE `lab_results` ADD `sample_collected_at` datetime(3);--> statement-breakpoint
ALTER TABLE `lab_results` ADD `result_date` datetime(3);--> statement-breakpoint
ALTER TABLE `lab_results` ADD `interpretation` text;--> statement-breakpoint
ALTER TABLE `lab_results` ADD `admin_response` text;--> statement-breakpoint
ALTER TABLE `lab_results` ADD `reviewed_at` datetime(3);