const crypto = require('crypto');

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(
    String(password || ''),
    salt,
    120000,
    32,
    'sha256'
  );
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
  };
}

function verifyPassword(password, saltHex, expectedHashHex) {
  const { hash } = hashPassword(password, saltHex);
  const left = Buffer.from(hash, 'hex');
  const right = Buffer.from(String(expectedHashHex || ''), 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { hashPassword, verifyPassword };

