const fs = require('node:fs');
const path = require('node:path');

async function saveIndex(filePath, index) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(index));
}

async function loadIndex(filePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Knowledge index not found at ${filePath}. Run \`npm run ingest\` first to build it.`);
    }
    throw err;
  }
  return JSON.parse(raw);
}

module.exports = { saveIndex, loadIndex };
