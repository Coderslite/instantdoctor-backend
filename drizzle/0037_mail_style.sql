-- Mail centre: plain branded emails (logo header + footer) alongside official letters.
ALTER TABLE `admin_emails` ADD COLUMN `style` enum('letter','email') NOT NULL DEFAULT 'letter';
