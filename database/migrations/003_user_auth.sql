-- Username/password auth support
SET NAMES utf8mb4;
SET time_zone = '+00:00';

ALTER TABLE users
  ADD COLUMN username VARCHAR(40) NULL,
  ADD COLUMN password_hash CHAR(64) NULL COMMENT 'SHA-256 PBKDF2 hash',
  ADD COLUMN password_salt CHAR(32) NULL COMMENT 'hex salt for PBKDF2';

ALTER TABLE users
  ADD UNIQUE KEY uq_users_username (username);

