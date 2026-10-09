ALTER TABLE `products` ADD `sku` varchar(80);--> statement-breakpoint
ALTER TABLE `products` ADD `manufacturer` varchar(255);--> statement-breakpoint
ALTER TABLE `products` ADD `batch_number` varchar(100);--> statement-breakpoint
ALTER TABLE `products` ADD `expiry_date` varchar(10);--> statement-breakpoint
ALTER TABLE `products` ADD `reorder_level` int NOT NULL DEFAULT 5;--> statement-breakpoint
CREATE INDEX `products_expiry_idx` ON `products` (`pharmacy_id`,`expiry_date`);
--> statement-breakpoint
CREATE TABLE `inventory_movements` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` int NOT NULL,
  `reason` varchar(255),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `inventory_movements_id` PRIMARY KEY(`id`),
  CONSTRAINT `inventory_movements_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade,
  CONSTRAINT `inventory_movements_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inventory_movements_product_idx` ON `inventory_movements` (`product_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `suppliers` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` varchar(255) NOT NULL,
  `contact_name` varchar(255),
  `phone_number` varchar(32),
  `email` varchar(191),
  `address` varchar(512),
  `status` varchar(32) NOT NULL DEFAULT 'active',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `suppliers_id` PRIMARY KEY(`id`),
  CONSTRAINT `suppliers_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suppliers_pharmacy_idx` ON `suppliers` (`pharmacy_id`,`status`);
--> statement-breakpoint
CREATE TABLE `purchase_orders` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `supplier_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
  `reference` varchar(32) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'draft',
  `expected_date` varchar(10),
  `notes` text,
  `total_cost` decimal(14,2) NOT NULL DEFAULT 0,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `purchase_orders_id` PRIMARY KEY(`id`),
  CONSTRAINT `purchase_orders_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade,
  CONSTRAINT `purchase_orders_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE set null,
  CONSTRAINT `purchase_orders_reference_uq` UNIQUE(`pharmacy_id`,`reference`)
);
--> statement-breakpoint
CREATE INDEX `purchase_orders_pharmacy_idx` ON `purchase_orders` (`pharmacy_id`,`status`);
--> statement-breakpoint
CREATE TABLE `purchase_order_items` (
  `id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purchase_order_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
  `product_name` varchar(255) NOT NULL,
  `quantity` int NOT NULL,
  `received_quantity` int NOT NULL DEFAULT 0,
  `unit_cost` decimal(14,2) NOT NULL,
  `batch_number` varchar(100),
  `expiry_date` varchar(10),
  CONSTRAINT `purchase_order_items_id` PRIMARY KEY(`id`),
  CONSTRAINT `purchase_order_items_purchase_order_id_purchase_orders_id_fk` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE cascade,
  CONSTRAINT `purchase_order_items_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `purchase_order_items_order_idx` ON `purchase_order_items` (`purchase_order_id`);
