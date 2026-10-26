'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const installer = require('./install-opencode');
const { createBridge } = require('../src/main/bridge');

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-opencode-'));
  const saved = { OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, CAPRI_PORT: process.env.CAPRI_PORT };
  const received = [];
  const server = createBridge({ port: 0, onEvent: (evt) => received.push(evt) });
  await once(server, 'listening');
  let cleanup;
  try {
    process.env.OPENCODE_CONFIG_DIR = scratch;
    process.env.CAPRI_PORT = String(server.address().port);
    fs.writeFileSync(path.join(scratch, 'opencode.jsonc'), '{ // leave my settings alone\n}');
    const other = path.join(scratch, 'plugins', 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'index.js'), 'other plugin');
    const installed = installer.install();
    assert.equal(installer.status().installed, true);
    const initial = fs.readFileSync(installed.file, 'utf8');
    installer.install();
    assert.equal(fs.readFileSync(installed.file, 'utf8'), initial);
    assert.ok(fs.readFileSync(path.join(scratch, 'opencode.jsonc'), 'utf8').includes('leave my settings alone'));

    const { default: plugin } = await import(pathToFileURL(installed.file));
    const hooks = {};
    let deliver;
    let ready;
    const subscribed = new Promise((resolve) => { ready = resolve; });
    const ctx = {
      location: { directory: 'C:/project' },
      session: { hook: async (name, fn) => { hooks[name] = fn; } },
      tool: { hook: async (name, fn) => { hooks[name] = fn; } },
      event: { subscribe: async function* ({ signal }) {
        ready();
        while (!signal.aborted) {
          const event = await new Promise((resolve) => {
            deliver = resolve;
            signal.addEventListener('abort', () => resolve(null), { once: true });
          });
          if (event) yield event;
        }
      } },
    };
    cleanup = await plugin.setup(ctx);
    await subscribed;
    async function emit(type, data, expected = 1, directory = 'C:/project') {
      const count = received.length;
      deliver({ type, data, location: { directory } });
      if (expected) {
        const limit = Date.now() + 2000;
        while (received.length < count + expected && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(received.length, count + expected, type);
      }
      // Let the stream advance back to waiting for its next event.
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await emit('session.created', { sessionID: 's1', title: 'Testing' });
    await hooks.prompt({ sessionID: 's1', prompt: { text: 'Do a task', files: [{ uri: 'secret-file' }] } });
    assert.equal(received.at(-1).hook_event_name, 'UserPromptSubmit');
    assert.equal(received.at(-1).provider, 'opencode');
    assert.equal(received.at(-1).session_id, 'opencode:s1');
    await emit('session.execution.started', { sessionID: 's1' }, 0);
    assert.equal(received.filter((e) => e.hook_event_name === 'UserPromptSubmit').length, 1);
    const edit = { tool: 'edit', sessionID: 's1', id: 'call1', input: { filePath: 'a.js', oldString: 'private content', newString: 'private content' } };
    await hooks['execute.before'](edit);
    assert.equal(received.at(-1).tool_name, 'Edit');
    assert.equal(received.at(-1).tool_input.file_path, 'a.js');
    await hooks['execute.after']({ ...edit, status: 'completed', result: { content: 'private output' } });
    assert.equal(received.at(-1).hook_event_name, 'PostToolUse');
    await hooks['execute.before']({ ...edit, tool: 'apply_patch', input: { patchText: '*** Update File: a.js\n+private content\n*** Add File: b.js' } });
    assert.deepEqual(received.at(-1).file_paths, ['a.js', 'b.js']);
    assert.ok(!received.at(-1).tool_input.command);
    await emit('permission.asked', { sessionID: 's1', action: 'shell', message: 'Allow shell?' });
    assert.equal(received.at(-1).notification_type, 'permission_prompt');
    await emit('permission.replied', { sessionID: 's1', reply: 'once' });
    assert.equal(received.at(-1).hook_event_name, 'PermissionResolved');
    await hooks['execute.before']({ ...edit, tool: 'question', input: { questions: [{ question: 'Which color?' }] } });
    assert.equal(received.at(-1).notification_type, 'agent_needs_input');
    await hooks['execute.after']({ ...edit, status: 'error', error: { message: 'Edit failed' } });
    assert.equal(received.at(-1).hook_event_name, 'PostToolUseFailure');
    await hooks['execute.after']({ ...edit, tool: 'bash', status: 'completed', result: { metadata: { exit: 1 } } });
    assert.equal(received.at(-1).hook_event_name, 'PostToolUseFailure');
    await emit('session.text.ended', { sessionID: 's1', assistantMessageID: 'm1', text: 'All done.' }, 0);
    await emit('session.execution.succeeded', { sessionID: 's1' });
    assert.equal(received.at(-1).last_assistant_message, 'All done.');
    await emit('session.execution.succeeded', { sessionID: 's1' }, 0);
    assert.equal(received.filter((e) => e.hook_event_name === 'Stop').length, 1);
    await emit('session.execution.interrupted', { sessionID: 's1' });
    assert.equal(received.at(-1).hook_event_name, 'Interrupt');
    await emit('session.execution.failed', { sessionID: 's1', error: { message: 'Provider failed' } });
    assert.equal(received.at(-1).hook_event_name, 'StopFailure');
    const count = received.length;
    await emit('session.created', { sessionID: 'elsewhere' }, 0, 'C:/other-project');
    assert.equal(received.length, count, 'ignore other locations');
    await emit('session.deleted', { sessionID: 's1' });
    assert.ok(!JSON.stringify(received).includes('private content'));
    assert.ok(!JSON.stringify(received).includes('private output'));
    assert.ok(!JSON.stringify(received).includes('secret-file'));
    await cleanup(); cleanup = null;
    installer.uninstall();
    assert.equal(installer.status().installed, false);
    assert.equal(fs.readFileSync(path.join(other, 'index.js'), 'utf8'), 'other plugin');
    fs.writeFileSync(installed.file, 'unrelated plugin');
    assert.throws(() => installer.install(), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(installed.file, 'utf8'), 'unrelated plugin');
    console.log('OpenCode integration checks passed.');
  } finally {
    if (cleanup) await cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
