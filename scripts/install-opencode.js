'use strict';

// A local OpenCode 2 plugin requires no API key, npm dependency, or edits to opencode.json(c).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function location() {
  return path.join(process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'), 'plugins', 'capri-desktop');
}

function status() {
  const file = path.join(location(), 'index.js');
  try {
    return { file, installed: fs.existsSync(file) && fs.readFileSync(file, 'utf8').startsWith('// Capri\'s OpenCode 2 plugin.') };
  } catch (error) { return { file, installed: false, error: error.message }; }
}

function install() {
  const dir = location();
  const source = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'opencode-plugin.mjs'), 'utf8');
  const files = { 'index.js': source, 'package.json': JSON.stringify({ name: 'capri-desktop-plugin', type: 'module', main: './index.js' }, null, 2) + '\n' };
  // Refuse to replace an unrelated plugin that happens to use Capri's directory name.
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      if (old !== content && !(name === 'index.js' && old.startsWith('// Capri\'s OpenCode 2 plugin.'))) throw new Error(`Refusing to overwrite ${file}`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) continue;
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.capri-backup-${Date.now()}`);
    fs.writeFileSync(file, content);
  }
  return { file: path.join(dir, 'index.js') };
}

function uninstall() {
  const { file, installed } = status();
  if (installed) {
    fs.unlinkSync(file);
    const manifest = path.join(location(), 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'capri-desktop-plugin') fs.unlinkSync(manifest);
  }
  return { file, removed: installed };
}

module.exports = { install, uninstall, status };
if (require.main === module) {
  try {
    const action = process.argv.includes('--uninstall') ? 'uninstall' : process.argv.includes('--status') ? 'status' : 'install';
    console.log(JSON.stringify(module.exports[action]()));
    if (action === 'install') console.log('Restart or reload OpenCode 2 to load Capri.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
