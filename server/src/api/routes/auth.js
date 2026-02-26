const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const db = require('../../db/connection');
const { hashPassword, verifyPassword } = require('../../utils/password');
const { signToken, buildAuthCookie, clearAuthCookie } = require('../../utils/authToken');
const { requireAuth } = require('../middlewares/auth');

const router = express.Router();

router.post(
  '/signup',
  [
    body('username').trim().isLength({ min: 3, max: 40 }).matches(/^[a-zA-Z0-9_]+$/),
    body('password').isLength({ min: 8, max: 200 }),
    body('email').optional({ nullable: true }).isEmail().withMessage('Invalid email format.'),
    body('phone').optional({ nullable: true }).isString().isLength({ min: 7, max: 20 }),
    body().custom((value) => {
      const email = String(value.email || '').trim();
      const phone = String(value.phone || '').trim();
      if (!email && !phone) throw new Error('Provide at least one contact: email or phone.');
      return true;
    }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const username = req.body.username.trim().toLowerCase();
    const password = req.body.password;
    const email = String(req.body.email || '').trim().toLowerCase() || null;
    const phone = normalisePhone(String(req.body.phone || '').trim()) || null;

    try {
      const [[existing]] = await db.execute(
        `SELECT id FROM users WHERE username = ?`,
        [username]
      );
      if (existing) return res.status(409).json({ error: 'Username already exists.' });

      const id = uuidv4();
      const pw = hashPassword(password);
      await db.execute(
        `INSERT INTO users (id, role, display_name, username, password_hash, password_salt, email, phone_e164, is_active, created_at)
         VALUES (?, 'guardian', ?, ?, ?, ?, ?, ?, 1, NOW())`,
        [id, username, username, pw.hash, pw.salt, email, phone]
      );

      const token = signToken({
        uid: id,
        exp: Date.now() + (7 * 24 * 60 * 60 * 1000),
      });
      res.setHeader('Set-Cookie', buildAuthCookie(token));
      return res.status(201).json({ success: true, user: { id, username, role: 'guardian', email, phone } });
    } catch (err) {
      if (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE')) {
        return res.status(500).json({
          error: 'Auth schema not ready. Run: npm run migrate',
        });
      }
      return res.status(500).json({ error: `Signup failed: ${err.message}` });
    }
  }
);

router.post(
  '/login',
  [
    body('username').trim().isLength({ min: 3, max: 40 }),
    body('password').isLength({ min: 1, max: 200 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const username = req.body.username.trim().toLowerCase();
    const password = req.body.password;

    try {
      const [[user]] = await db.execute(
        `SELECT id, username, role, password_hash, password_salt, is_active
         FROM users WHERE username = ?`,
        [username]
      );
      if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials.' });
      if (!user.password_hash || !user.password_salt) return res.status(401).json({ error: 'Invalid credentials.' });
      if (!verifyPassword(password, user.password_salt, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const token = signToken({
        uid: user.id,
        exp: Date.now() + (7 * 24 * 60 * 60 * 1000),
      });
      res.setHeader('Set-Cookie', buildAuthCookie(token));
      return res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      if (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE')) {
        return res.status(500).json({
          error: 'Auth schema not ready. Run: npm run migrate',
        });
      }
      return res.status(500).json({ error: `Login failed: ${err.message}` });
    }
  }
);

router.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookie());
  return res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

module.exports = router;

function normalisePhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) return cleaned;
  return `+${cleaned}`;
}
