// Shared config handling for server.js and setup.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = process.env.MOODLE_CONFIG || path.join(os.homedir(), '.moodle-mcp', 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

// Accepts any page of the site (e.g. https://moodle.uni.edu/my/) and returns the site root.
function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  let p = u.pathname.replace(/\/(my|login|course|mod|user|admin|calendar|grade|webservice)(\/.*)?$/i, '').replace(/\/index\.php$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${p}`;
}

module.exports = { CONFIG_PATH, readConfig, writeConfig, normalizeSiteUrl };
