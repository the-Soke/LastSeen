const db = require('../../db/connection');
const { COOKIE_NAME, parseCookie, verifyToken } = require('../../utils/authToken');

async function optionalAuth(req, _res, next) {
  req.user = null;
  try {
    const token = parseCookie(req, COOKIE_NAME);
    const payload = verifyToken(token);
    if (!payload) return next();

    const [[user]] = await db.execute(
      `SELECT id, username, role, is_active
       FROM users
       WHERE id = ?`,
      [payload.uid]
    );
    if (!user || !user.is_active) return next();
    req.user = { id: user.id, username: user.username, role: user.role };
  } catch {
    // Ignore auth parsing failures and continue as anonymous.
  }
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  return next();
}

module.exports = { optionalAuth, requireAuth };

