CREATE TABLE `pharmacy_staff` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(191),
  `phone_number` varchar(32),
  `role` varchar(80) NOT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `pharmacy_staff_id` PRIMARY KEY(`id`),
  CONSTRAINT `pharmacy_staff_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pharmacy_staff_pharmacy_idx` ON `pharmacy_staff` (`pharmacy_id`,`status`);
