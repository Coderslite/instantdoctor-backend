CREATE TABLE `pos_sales` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`pharmacy_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`receipt_number` varchar(40) NOT NULL,
	`device_id` varchar(64),
	`cashier_staff_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`cashier_name` varchar(255) NOT NULL,
	`customer_name` varchar(255),
	`customer_phone` varchar(32),
	`subtotal` decimal(14,2) NOT NULL,
	`discount_total` decimal(14,2) NOT NULL DEFAULT 0,
	`total` decimal(14,2) NOT NULL,
	`payments` json NOT NULL,
	`amount_tendered` decimal(14,2) NOT NULL,
	`change_due` decimal(14,2) NOT NULL DEFAULT 0,
	`status` enum('completed','voided') NOT NULL DEFAULT 'completed',
	`notes` varchar(500),
	`void_reason` varchar(255),
	`voided_by_name` varchar(255),
	`voided_at` datetime(3),
	`stock_warnings` json,
	`sold_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `pos_sales_id` PRIMARY KEY(`id`),
	CONSTRAINT `pos_sales_receipt_uq` UNIQUE(`pharmacy_id`,`receipt_number`),
	CONSTRAINT `pos_sales_pharmacy_id_pharmacies_id_fk` FOREIGN KEY (`pharmacy_id`) REFERENCES `pharmacies`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `pos_sales_cashier_staff_id_pharmacy_staff_id_fk` FOREIGN KEY (`cashier_staff_id`) REFERENCES `pharmacy_staff`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `pos_sales_pharmacy_idx` ON `pos_sales` (`pharmacy_id`,`sold_at`);
--> statement-breakpoint
CREATE INDEX `pos_sales_cashier_idx` ON `pos_sales` (`pharmacy_id`,`cashier_staff_id`,`sold_at`);
--> statement-breakpoint
CREATE TABLE `pos_sale_items` (
	`id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`sale_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`product_id` varchar(36) CHARACTER SET ascii COLLATE ascii_bin,
	`name` varchar(255) NOT NULL,
	`sku` varchar(80),
	`batch_number` varchar(100),
	`unit_price` decimal(14,2) NOT NULL,
	`discount` int NOT NULL DEFAULT 0,
	`quantity` int NOT NULL,
	`line_total` decimal(14,2) NOT NULL,
	`unit_cost` decimal(14,2),
	CONSTRAINT `pos_sale_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `pos_sale_items_sale_id_pos_sales_id_fk` FOREIGN KEY (`sale_id`) REFERENCES `pos_sales`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `pos_sale_items_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `pos_sale_items_sale_idx` ON `pos_sale_items` (`sale_id`);
