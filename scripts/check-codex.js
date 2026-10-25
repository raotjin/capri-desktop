'use strict';

// Run with npm run test:codex. No Electron, live settings, or running Capri required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createBridge } = require('../src/main/bridge');
const hooks = require('./install-hooks');

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-codex-'));
  const oldHome = process.env.CODEX_HOME;
  const received = [];
  const server = createBridge({ port: 0, onEvent: (evt) => received.push(evt) });
  await once(server, 'listening');
  const port = server.address().port;
  async function send(evt, codex = true, command) {
    const child = spawn(command ? 'powershell.exe' : process.execPath, command
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : [path.resolve(__dirname, '../hooks/capri-hook.js'), ...(codex ? ['--codex'] : [])], {
      env: { ...process.env, CAPRI_PORT: String(port) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => { stdout += s; });
    child.stderr.on('data', (s) => { stderr += s; });
    const closed = once(child, 'close');
    child.stdin.end(JSON.stringify(evt));
    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(stdout + stderr, '');
    return received.at(-1);
  }
  try {
    process.env.CODEX_HOME = scratch;
    const file = path.join(scratch, 'hooks.json');
    const other = { type: 'command', command: 'echo existing-hook' };
    fs.writeFileSync(file, JSON.stringify({ description: 'keep me', hooks: { Stop: [{ hooks: [other, { type: 'command', command: 'node capri-hook.js --codex' }] }] } }));
    const installed = hooks.install('codex');
    assert.equal(installed.events, 11);
    if (process.platform === 'win32') {
      const delivered = await send({ hook_event_name: 'SessionStart', session_id: 'windows-command' }, true, installed.command);
      assert.equal(delivered.session_id, 'codex:windows-command');
    }
    assert.equal(hooks.status('codex').installed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).hooks.Stop[0].hooks, [other]);
    assert.equal(JSON.parse(fs.readFileSync(file)).description, 'keep me');
    const before = fs.readFileSync(file, 'utf8');
    hooks.install('codex');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'reinstall must be idempotent');
    hooks.uninstall('codex');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { description: 'keep me', hooks: { Stop: [{ hooks: [other] }] } });
    fs.writeFileSync(file, 'invalid json');
    assert.throws(() => hooks.install('codex'), /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'invalid json');

    const common = { session_id: 'test', cwd: 'C:/project' };
    const prompt = await send({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Work please' });
    assert.equal(prompt.provider, 'codex');
    assert.equal(prompt.session_id, 'codex:test');
    const patch = await send({ ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: a.js\n+private file content\n*** Add File: b.js\n+private file content\n*** End Patch' } });
    assert.equal(patch.tool_name, 'Edit');
    assert.deepEqual(patch.file_paths, ['a.js', 'b.js']);
    assert.ok(!JSON.stringify(patch).includes('private file content'));
    const permission = await send({ ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo ok', description: 'Allow command?' } });
    assert.equal(permission.notification_type, 'permission_prompt');
    const question = await send({ ...common, hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which color?' }] } });
    assert.equal(question.notification_type, 'agent_needs_input');
    assert.equal(question.message, 'Which color?');
    const failure = await send({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'Process exited with code 1\nOutput:\nfailed' });
    assert.equal(failure.hook_event_name, 'PostToolUseFailure');
    const structured = await send({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 2, output: 'private output' } });
    assert.equal(structured.hook_event_name, 'PostToolUseFailure');
    assert.ok(!JSON.stringify(structured).includes('private output'));
    const success = await send({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 0 } });
    assert.equal(success.hook_event_name, 'PostToolUse');
    const stop = await send({ ...common, hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(7000) });
    assert.equal(stop.last_assistant_message.length, 6001);
    const claude = await send({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'c.js', content: 'secret' } }, false);
    assert.equal(claude.session_id, 'test');
    assert.equal(claude.tool_input.content_len, 6);
    const count = received.length;
    await send(null);
    assert.equal(received.length, count, 'invalid input must not be forwarded');

    global.matchMedia = () => ({ matches: false });
    const { Brain } = await import(pathToFileURL(path.resolve(__dirname, '../src/renderer/js/brain.js')));
    const panels = [];
    const capri = new Proxy({ windows: { fg: null }, mode: 'idle', setMode(mode) { this.mode = mode; } }, { get: (obj, key) => obj[key] ?? (() => {}) });
    const brain = new Brain({ capri, panel: { say: (p) => panels.push(p), setTicker() {}, clearKind() {} }, voice: { play() {} }, host: { cursor: async () => null }, lang: 'en' });
    brain.handle(prompt);
    brain.handle(patch);
    assert.equal(brain.sessions.get('codex:test').files.size, 2);
    await brain.handle(permission);
    assert.equal(capri.mode, 'alert');
    assert.equal(brain.sessions.get('codex:test').waiting, true);
    assert.ok(!panels.at(-1).line.includes('Claude'));
    brain.handle(success);
    assert.equal(brain.sessions.get('codex:test').waiting, false);
    brain.handle({ ...prompt, hook_event_name: 'Interrupt' });
    assert.equal(capri.mode, 'idle');
    assert.equal(brain.busySessions.length, 0);
    brain.session(claude);
    assert.equal(brain.sessions.size, 2, 'providers must not share sessions');
    console.log('Codex integration checks passed.');
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
