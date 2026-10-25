#!/usr/bin/env node
'use strict';

// Adds (or removes) the Capri hooks in ~/.claude/settings.json.
// Existing settings and hooks are kept; a timestamped backup is written first.
//
//   node scripts/install-hooks.js            install
//   node scripts/install-hooks.js --uninstall
//   node scripts/install-hooks.js --status

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
];

const MARK = 'capri-hook.js';

function settingsPath(provider = 'claude') {
  if (provider === 'codex') return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

function hasNode() {
  try {
    return spawnSync('node', ['-v'], { windowsHide: true, timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

// In the installed app (the .exe) the hook sits next to the app archive (asarUnpack), where
// node can read it. With no node on the machine, Capri's own executable runs it as node.
function hookCommand(provider = 'claude') {
  const script = path.resolve(__dirname, '..', 'hooks', 'capri-hook.js')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    .replace(/\\/g, '/');
  if (provider === 'codex') {
    // Codex uses PowerShell on Windows; keep the command valid with or without Node installed.
    const runtime = hasNode() ? 'node' : process.execPath;
    if (process.platform === 'win32') {
      const quote = (s) => `'${s.replace(/'/g, "''")}'`;
      return `${runtime === 'node' ? '' : '$env:ELECTRON_RUN_AS_NODE=\'1\'; '}& ${quote(runtime)} ${quote(script)} --codex`;
    }
    return `${runtime === 'node' ? 'node' : `ELECTRON_RUN_AS_NODE=1 "${runtime}"`} "${script}" --codex`;
  }
  if (process.versions.electron && !hasNode()) {
    return `ELECTRON_RUN_AS_NODE=1 "${process.execPath.replace(/\\/g, '/')}" "${script}"`;
  }
  return `node "${script}"`;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    // Never overwrite a file we could not understand.
    throw new Error(`${file} is not valid JSON (${err.message}). Fix it first, nothing was changed.`);
  }
}

function isCapriGroup(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => String(h.command || '').includes(MARK));
}

function strip(settings) {
  if (!settings.hooks) return settings;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.map((g) => isCapriGroup(g)
      ? { ...g, hooks: g.hooks.filter((h) => !String(h.command || '').includes(MARK)) } : g)
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

function write(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.capri-backup-${stamp}`);
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function install(provider = 'claude') {
  const file = settingsPath(provider);
  const original = readSettings(file);
  const before = JSON.stringify(original);
  const settings = strip(original);
  settings.hooks = settings.hooks || {};
  const command = hookCommand(provider);
  const events = provider === 'codex'
    ? EVENTS.filter((event) => !['Notification', 'PostToolUseFailure', 'StopFailure'].includes(event)).concat('PermissionRequest', 'Interrupt')
    : EVENTS;
  for (const event of events) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({
      // ponytail: local Codex delivery is synchronous to preserve event order; the sender gives up in 2s.
      hooks: [{ type: 'command', command, ...(provider === 'codex' ? {} : { async: true }), timeout: provider === 'codex' ? 3 : 10 }],
    });
  }
  if (JSON.stringify(settings) !== before) write(file, settings); // already up to date: no backup spam
  return { file, command, events: events.length };
}

function uninstall(provider = 'claude') {
  const file = settingsPath(provider);
  if (!fs.existsSync(file)) return { file, removed: false };
  const settings = readSettings(file);
  const before = JSON.stringify(settings);
  strip(settings);
  const removed = JSON.stringify(settings) !== before;
  if (removed) write(file, settings);
  return { file, removed };
}

function status(provider = 'claude') {
  const file = settingsPath(provider);
  try {
    const settings = readSettings(file);
    const events = Object.entries(settings.hooks || {})
      .filter(([, groups]) => Array.isArray(groups) && groups.some(isCapriGroup))
      .map(([event]) => event);
    return { file, installed: events.length > 0, events };
  } catch (err) {
    return { file, installed: false, events: [], error: err.message };
  }
}

module.exports = { install, uninstall, status, EVENTS };

if (require.main === module) {
  const arg = process.argv[2];
  const provider = process.argv.includes('--codex') ? 'codex' : 'claude';
  try {
    if (arg === '--uninstall') {
      const r = uninstall(provider);
      console.log(r.removed ? `Capri hooks removed from ${r.file}` : `No Capri hooks found in ${r.file}`);
    } else if (arg === '--status') {
      const r = status(provider);
      console.log(r.installed ? `Installed (${r.events.join(', ')}) in ${r.file}` : `Not installed (${r.file})`);
    } else {
      const r = install(provider);
      console.log(`Capri hooks installed for ${r.events} events in ${r.file}`);
      console.log(`Command: ${r.command}`);
      console.log(provider === 'codex' ? 'Restart Codex and review/trust the Capri hooks in /hooks.' : 'Start a new Claude Code session for them to take effect.');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
