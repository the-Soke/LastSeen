-- Reporter contact channels for high-score AI alerts
SET NAMES utf8mb4;
SET time_zone = '+00:00';

ALTER TABLE users
  ADD COLUMN email VARCHAR(190) NULL,
  ADD COLUMN phone_e164 VARCHAR(20) NULL;

ALTER TABLE users
  ADD UNIQUE KEY uq_users_email (email),
  ADD INDEX idx_users_phone (phone_e164);

