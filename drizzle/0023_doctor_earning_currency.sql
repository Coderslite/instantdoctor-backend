ALTER TABLE `users`
  ADD COLUMN `earning_currency` varchar(3) NOT NULL DEFAULT 'NGN';
--> statement-breakpoint

UPDATE `users` u
JOIN `currencies` c ON c.`code` = UPPER(u.`currency`)
SET u.`earning_currency` = UPPER(c.`code`)
WHERE u.`role` = 'doctor' AND u.`currency` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `appointments`
  ADD COLUMN `doctor_earning_converted` decimal(14,2),
  ADD COLUMN `doctor_earning_currency` varchar(3),
  ADD COLUMN `doctor_earning_exchange_rate` decimal(18,8),
  ADD COLUMN `doctor_earning_converted_at` datetime(3);
