#!/usr/bin/env node
// Interactive setup: gets a Moodle token and saves it to ~/.moodle-mcp/config.json.
//   node setup.js [site-url]       full setup (asks for your login in this terminal)
//   node setup.js --probe <url>    non-interactive: report whether the site supports this (safe for agents)
'use strict';

const readline = require('readline');
const { CONFIG_PATH, readConfig, writeConfig, normalizeSiteUrl } = require('./config');

const args = process.argv.slice(2);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Reads a line without echoing it (for passwords and tokens).
function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('Run setup in an interactive terminal (not through an AI agent).');
  return new Promise((resolve) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function publicConfig(site) {
  const res = await fetch(`${site}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }]),
  });
  let r;
  try { [r] = JSON.parse(await res.text()); } catch {}
  if (!r || r.error) throw new Error(`${site} does not look like a Moodle site (or it is too old). Check the URL.`);
  return r.data;
}

function describe(cfg) {
  if (!cfg.enablewebservices || !cfg.enablemobilewebservice) {
    return { ok: false, text: 'This site has the Moodle mobile app API turned off, so this tool cannot connect. Ask your school to enable it.' };
  }
  // typeoflogin: 1 = username/password in the app, 2/3 = browser single sign-on.
  return cfg.typeoflogin === 1
    ? { ok: true, sso: false, text: 'Supported: log in with your Moodle username and password.' }
    : { ok: true, sso: true, text: 'Supported via single sign-on: you will copy a login link from your browser.' };
}

async function tokenFromPassword(site) {
  const username = await ask('Moodle username: ');
  const password = await askHidden('Password (hidden): ');
  const body = new URLSearchParams({ username, password, service: 'moodle_mobile_app' });
  const r = await (await fetch(`${site}/login/token.php`, { method: 'POST', body })).json();
  if (!r.token) throw new Error(`Login failed: ${r.error || 'no token returned'}`);
  return r.token;
}

// SSO sites: the mobile "launch" page redirects to moodlemobile://token=<base64 "sig:::token[:::private]">.
async function tokenFromSso(site) {
  const launch = `${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${Date.now()}&urlscheme=moodlemobile`;
  console.log('\n1. Log in to Moodle in your browser.');
  console.log('2. Open your browser\'s developer tools (F12 on Windows, Cmd+Option+I on Mac) and select the Console tab.');
  console.log(`3. In the same tab, open this address:\n   ${launch}`);
  console.log('4. The console shows an error about a "moodlemobile://token=..." link that could not be opened. Copy that whole link.\n');
  const input = await askHidden('Paste the moodlemobile:// link, or a token you already have (hidden): ');
  const m = input.match(/token=([A-Za-z0-9+/=_-]+)/);
  if (!m) return input.trim();
  const parts = Buffer.from(m[1], 'base64').toString('utf8').split(':::');
  if (!parts[1]) throw new Error('Could not read a token from that link.');
  return parts[1];
}

async function verify(site, token) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: 'core_webservice_get_site_info', moodlewsrestformat: 'json' });
  const r = await (await fetch(`${site}/webservice/rest/server.php`, { method: 'POST', body })).json();
  if (r.exception) throw new Error(`Token rejected: ${r.message}`);
  return r;
}

async function main() {
  if (args[0] === '--probe') {
    const site = normalizeSiteUrl(args[1]);
    if (!site) throw new Error('Usage: node setup.js --probe <moodle-url>');
    const d = describe(await publicConfig(site));
    console.log(`${site}: ${d.text}`);
    process.exitCode = d.ok ? 0 : 2;
    return;
  }

  const existing = readConfig();
  const site = normalizeSiteUrl(args[0] || existing.url || await ask('Moodle site URL (e.g. https://moodle.myschool.edu): '));
  if (!site) throw new Error('A Moodle site URL is required.');
  const d = describe(await publicConfig(site));
  console.log(`${site}: ${d.text}`);
  if (!d.ok) { process.exitCode = 2; return; }

  const token = d.sso ? await tokenFromSso(site) : await tokenFromPassword(site);
  const info = await verify(site, token);
  writeConfig({ ...existing, url: site, token });
  console.log(`\nConnected as ${info.fullname}. Saved to ${CONFIG_PATH} (readable only by you).`);
  console.log('Your password was not stored. Restart Claude Code (or your MCP client) to use the Moodle tools.');
}

main().catch((e) => { console.error(`\nSetup failed: ${e.message}`); process.exitCode = 1; });
