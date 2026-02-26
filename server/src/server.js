require('dotenv').config();
const app = require('./app');
const { startBackgroundJobs, stopBackgroundJobs } = require('./services/backgroundJobs');

const PORT = Number(process.env.PORT || 4000);

const server = app.listen(PORT, () => {
  console.log(`[LastSeen] API listening on http://localhost:${PORT}`);
  startBackgroundJobs();
});

function shutdown(signal) {
  console.log(`[LastSeen] Received ${signal}. Shutting down...`);
  stopBackgroundJobs();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

