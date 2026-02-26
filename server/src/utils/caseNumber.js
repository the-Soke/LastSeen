function generateCaseNumber(now = new Date()) {
  const year = now.getFullYear();
  const rand = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `LS-${year}-${rand}`;
}

module.exports = { generateCaseNumber };
