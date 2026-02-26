function out(level, args) {
  const stamp = new Date().toISOString();
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](`[${stamp}] [${level.toUpperCase()}]`, ...args);
}

module.exports = {
  info: (...args) => out('info', args),
  warn: (...args) => out('warn', args),
  error: (...args) => out('error', args),
  debug: (...args) => {
    if (process.env.LOG_LEVEL === 'debug') out('debug', args);
  },
};
