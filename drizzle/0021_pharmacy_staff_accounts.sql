ALTER TABLE `pharmacy_staff`
  ADD COLUMN `password_hash` varchar(255),
  ADD COLUMN `must_change_password` boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT `pharmacy_staff_email_uq` UNIQUE (`email`);
--> statement-breakpoint
ALTER TABLE `portal_sessions`
  MODIFY `subject_type` enum('admin','pharmacy','pharmacy_staff') NOT NULL;
