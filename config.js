const path = require('path');
const os = require('os');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const isWin = os.platform() === 'win32';

const DEFAULTS = {
  CHROME_PATH: isWin
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/google-chrome',
  USER_DATA_DIR: isWin
    ? path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
    : path.join(os.homedir(), '.config', 'google-chrome'),
  PORT: 9222,
};

module.exports = { DATA_DIR, SETTINGS_FILE, DEFAULTS };
