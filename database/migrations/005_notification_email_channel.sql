-- Notification log channel update to support email delivery records
SET NAMES utf8mb4;
SET time_zone = '+00:00';

ALTER TABLE notification_log
  MODIFY COLUMN channel ENUM('push','sms','email') NOT NULL;

