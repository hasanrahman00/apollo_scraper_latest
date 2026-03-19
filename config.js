const path = require('path');
const os = require('os');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const isWin = os.platform() === 'win32';

// Everything reads from .env first, fallback only if missing
const DEFAULTS = {
  CHROME_PATH: process.env.CHROME_PATH || (isWin
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/google-chrome'),
  USER_DATA_DIR: process.env.CHROME_USER_DATA || (isWin
    ? path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
    : path.join(os.homedir(), '.config', 'google-chrome')),
  PORT: parseInt(process.env.CHROME_DEBUG_PORT, 10) || 9222,
};

module.exports = { DATA_DIR, SETTINGS_FILE, DEFAULTS };