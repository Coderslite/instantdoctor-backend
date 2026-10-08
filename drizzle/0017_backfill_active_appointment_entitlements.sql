-- Legacy bookings predate immutable package snapshots. Capture the package
-- configuration only for consultations that are still in progress or pending.
UPDATE `appointments` AS `appointment`
INNER JOIN `appointment_packages` AS `package` ON `package`.`id` = `appointment`.`package_id`
SET `appointment`.`package_features` = `package`.`features`
WHERE `appointment`.`package_features` IS NULL
  AND `appointment`.`status` IN ('pending', 'active');
