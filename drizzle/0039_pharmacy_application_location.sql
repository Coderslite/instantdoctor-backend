ALTER TABLE `pharmacy_applications` DROP COLUMN `offers_delivery`;
--> statement-breakpoint
ALTER TABLE `pharmacy_applications` ADD `latitude` decimal(10,7);
--> statement-breakpoint
ALTER TABLE `pharmacy_applications` ADD `longitude` decimal(10,7);
