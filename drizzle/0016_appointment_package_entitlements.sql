ALTER TABLE `appointment_packages` ADD `features` json;--> statement-breakpoint
UPDATE `appointment_packages` SET `features` = JSON_OBJECT(
  'allowVideoCall', IF(`type` IN ('standard', 'special'), true, false),
  'allowVoiceCall', IF(`type` IN ('standard', 'special'), true, false),
  'allowChat', true,
  'allowPrescription', true,
  'allowFamilyCredit', false,
  'followUpDays', IF(`type` = 'special', 7, 0),
  'included', JSON_ARRAY('Secure chat', 'Prescription when clinically appropriate')
) WHERE `features` IS NULL;--> statement-breakpoint
ALTER TABLE `appointment_packages` MODIFY COLUMN `features` json NOT NULL;--> statement-breakpoint
ALTER TABLE `appointment_packages` ADD `sort_order` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `appointment_packages` ADD `is_recommended` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `appointment_packages` ADD `badge` varchar(64);--> statement-breakpoint
ALTER TABLE `appointments` ADD `package_features` json;
