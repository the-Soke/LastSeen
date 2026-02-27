// server/src/app.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const reportsRouter = require('./api/routes/reports');
const { optionalAuth } = require('./api/middlewares/auth');

const app = express();

if (process.env.NODE_ENV === 'production') {
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === 'dev-auth-secret-change-me') {
    console.warn('[Security] AUTH_SECRET is missing or using a default value.');
  }
  if (!process.env.DATA_ENCRYPTION_KEY) {
    console.warn('[Security] DATA_ENCRYPTION_KEY is not set. Sensitive text is not encrypted at rest.');
  }
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com', 'fonts.googleapis.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com', 'fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', '*.tile.openstreetmap.org'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
    },
  },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  credentials: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: { error: 'Report limit reached. Contact a coordinator if urgent.' },
});

app.use(limiter);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(optionalAuth);

const uploadsDir = path.join(__dirname, '../../uploads');
if (process.env.STORAGE_DRIVER !== 's3' && fs.existsSync(uploadsDir)) {
  app.use('/uploads', express.static(uploadsDir));
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lastseen-api' });
});

app.use('/api/reports', reportLimiter, reportsRouter);

const optionalRoutes = [
  { base: '/api/auth', rel: './api/routes/auth' },
  { base: '/api/push', rel: './api/routes/push' },
  { base: '/api/location', rel: './api/routes/location' },
  { base: '/api/tips', rel: './api/routes/tips' },
  { base: '/api/ai', rel: './api/routes/ai' },
];

for (const route of optionalRoutes) {
  try {
    const router = require(route.rel);
    app.use(route.base, router);
  } catch (err) {
    console.warn(`[App] Skipping optional route ${route.base}: ${err.message}`);
  }
}

const distDir = path.join(__dirname, '../../client/dist');
const publicDir = path.join(__dirname, '../../client/public');
const staticDir = fs.existsSync(distDir) ? distDir : publicDir;

app.use(express.static(staticDir));

app.get('/', (_req, res) => {
  const candidate = fs.existsSync(path.join(staticDir, 'index.html'))
    ? 'index.html'
    : 'ReportWizard.html';
  res.sendFile(path.join(staticDir, candidate));
});

app.get('/feed', (_req, res) => {
  res.sendFile(path.join(staticDir, 'PublicDiscoveryFeed.html'));
});

app.get('/tip', (_req, res) => {
  res.sendFile(path.join(staticDir, 'AnonymousTipForm.html'));
});

app.get('/report', (_req, res) => {
  res.sendFile(path.join(staticDir, 'ReportWizard.html'));
});

app.get('/auth', (_req, res) => {
  res.sendFile(path.join(staticDir, 'Auth.html'));
});

app.get('/resolve', (_req, res) => {
  res.sendFile(path.join(staticDir, 'ResolveCase.html'));
});

app.get('/ai', (_req, res) => {
  res.sendFile(path.join(staticDir, 'AIReviewPanel.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(staticDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  const reportPath = path.join(staticDir, 'ReportWizard.html');
  if (fs.existsSync(reportPath)) {
    return res.sendFile(reportPath);
  }
  return res.status(404).json({ error: 'No web app build found in client/public or client/dist.' });
});

app.use((err, _req, res, _next) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : err.message,
  });
});

module.exports = app;
