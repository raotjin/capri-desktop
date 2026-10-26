// Capri's OpenCode 2 plugin. Self-contained: copied to the global plugins directory.
import http from 'node:http';

const short = (value, max = 280) => typeof value === 'string' ? value.slice(0, max) : undefined;

function post(event) {
  return new Promise((resolve) => {
    const body = JSON.stringify(event);
    const req = http.request({
      host: '127.0.0.1', port: Number(process.env.CAPRI_PORT) || 47823, path: '/event', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on('end', done); res.on('error', done); });
    const timer = setTimeout(() => { req.destroy(); done(); }, 800);
    function done() { clearTimeout(timer); resolve(); }
    req.on('error', done);
    req.end(body);
  });
}

function toolEvent(event) {
  const input = event.input || {};
  const names = { read: 'Read', write: 'Write', edit: 'Edit', multiedit: 'MultiEdit', bash: 'Bash', shell: 'Bash',
    grep: 'Grep', glob: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task', subagent: 'Agent', skill: 'Skill', apply_patch: 'Edit' };
  const tool_input = {};
  // Only display metadata crosses the bridge; never forward raw file edits or tool output.
  for (const [key, value] of Object.entries({
    file_path: input.filePath || input.file_path || input.path, command: input.command || input.cmd,
    description: input.description, pattern: input.pattern, query: input.query, url: input.url,
    skill: input.name, subagent_type: input.subagent_type,
  })) if (typeof value === 'string') tool_input[key] = short(value);
  const patch = event.tool === 'apply_patch' ? input.patchText || input.patch || input.command : '';
  const file_paths = typeof patch === 'string'
    ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].slice(0, 8).map((m) => short(m[1].trim())) : [];
  if (event.tool === 'apply_patch') {
    delete tool_input.command;
    tool_input.file_path = file_paths[0];
  }
  return { tool_name: names[event.tool] || short(event.tool), tool_use_id: short(event.id), tool_input, file_paths };
}

export default {
  id: 'capri-desktop',
  async setup(ctx) {
    const directory = ctx.location.directory;
    const sessions = new Map();
    function state(id) {
      if (!sessions.has(id)) {
        // ponytail: keep at most 128 sessions; older sessions start a fresh display summary if revisited.
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
        sessions.set(id, { reply: '', message: null, working: false });
      }
      return sessions.get(id);
    }
    function send(id, hook_event_name, fields = {}) {
      if (typeof id !== 'string' || !id) return Promise.resolve();
      return post({ provider: 'opencode', session_id: `opencode:${id}`, cwd: directory, hook_event_name, ...fields });
    }
    await ctx.session.hook('prompt', async (event) => {
      Object.assign(state(event.sessionID), { reply: '', message: null, working: true });
      await send(event.sessionID, 'UserPromptSubmit', { prompt: short(event.prompt?.text) });
    });
    await ctx.tool.hook('execute.before', async (event) => {
      const s = state(event.sessionID);
      s.working = true;
      const tool = toolEvent(event);
      if (event.tool === 'question') {
        const questions = event.input?.questions;
        await send(event.sessionID, 'Notification', { notification_type: 'agent_needs_input',
          message: short(Array.isArray(questions) ? questions.map((q) => q.question).join('\n') : 'OpenCode needs your answer.') });
      } else await send(event.sessionID, 'PreToolUse', tool);
    });
    await ctx.tool.hook('execute.after', async (event) => {
      const code = event.result?.metadata?.exit ?? event.result?.metadata?.exit_code;
      const failed = event.status === 'error' || (typeof code === 'number' && code !== 0);
      await send(event.sessionID, failed ? 'PostToolUseFailure' : 'PostToolUse', {
        ...toolEvent(event), ...(failed ? { error: short(event.error?.message) || `OpenCode tool failed${code == null ? '' : ` (exit code ${code})`}` } : {}),
      });
    });
    const controller = new AbortController();
    // Reconnect the public event stream after a transient disconnect; unloading cancels both stream and retry.
    const stream = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.location?.directory !== directory) continue; // subscription covers every server location
            const data = event.data || {};
            const id = data.sessionID;
            if (typeof id !== 'string') continue;
            switch (event.type) {
              case 'session.created':
                await send(id, 'SessionStart', { session_title: short(data.title), source: 'startup' }); break;
              case 'session.execution.started':
                if (!state(id).working) {
                  state(id).working = true;
                  await send(id, 'UserPromptSubmit');
                }
                break;
              case 'session.text.ended': {
                const s = state(id);
                if (s.message !== data.assistantMessageID) { s.reply = ''; s.message = data.assistantMessageID; }
                s.reply = (s.reply + (s.reply ? '\n\n' : '') + (data.text || '')).slice(0, 6000);
                break;
              }
              case 'permission.asked':
                await send(id, 'Notification', { notification_type: 'permission_prompt', message: short(data.message) || `OpenCode needs permission: ${short(data.action) || 'tool'}` }); break;
              case 'permission.replied': await send(id, 'PermissionResolved'); break;
              case 'session.compaction.started': await send(id, 'PreCompact'); break;
              case 'session.execution.succeeded': {
                const s = state(id);
                if (s.working) await send(id, 'Stop', { last_assistant_message: s.reply });
                s.working = false; s.reply = ''; s.message = null;
                break;
              }
              case 'session.execution.interrupted':
              case 'session.execution.failed':
                state(id).working = false;
                state(id).reply = '';
                await send(id, event.type.endsWith('failed') ? 'StopFailure' : 'Interrupt', { error: short(data.error?.message) }); break;
              case 'session.deleted':
                sessions.delete(id);
                await send(id, 'SessionEnd'); break;
            }
          }
        } catch { /* Capri is advisory: a disconnected observer must never fail an OpenCode turn. */ }
        if (!controller.signal.aborted) await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 1000);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    })();
    return async () => { controller.abort(); await stream; sessions.clear(); };
  },
};
