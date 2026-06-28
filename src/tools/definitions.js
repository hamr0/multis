/**
 * Tool definitions — name, description, input_schema, platforms, execute fn.
 *
 * Each tool has:
 *   name        — unique identifier sent to LLM
 *   description — what the LLM sees (guides tool selection)
 *   platforms   — which platforms support it ['linux','macos']
 *   input_schema— JSON Schema for parameters
 *   execute     — async (input, ctx) => string result
 *
 * ctx has: { senderId, chatId, isOwner, platform (runtime), indexer, memoryManager }
 */

const { execCommand, execArgv, readFile } = require('../skills/executor');
const { rememberWithSupersede } = require('../memory/supersede');

// Single-quote shell escaper for the few tools that genuinely need a shell
// (pipes, `||` fallbacks). Single quotes disable ALL shell expansion; the
// replace escapes an embedded single quote. Unlike JSON.stringify (which uses
// double quotes and leaves `$()`/backticks live), this is injection-safe.
// Prefer execArgv (no shell at all) wherever a single command suffices.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Allowed media_control actions — single-sourced into both the schema enum and
// the runtime guard. The schema enum is advisory only (the adapter does not
// enforce it), so the execute fn MUST re-check before the value reaches a command.
const MEDIA_ACTIONS = ['play', 'pause', 'play-pause', 'next', 'previous', 'stop'];

const TOOLS = [
  // -------------------------------------------------------------------------
  // Universal tools (all platforms)
  // -------------------------------------------------------------------------
  {
    name: 'exec',
    description: 'Run a shell command on the local machine. Governance (command allowlist/denylist) is handled by the Loop policy, not this tool.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' }
      },
      required: ['command']
    },
    execute: async ({ command }, ctx) => {
      const result = await execCommand(command, ctx.senderId);
      return result.output;
    }
  },
  {
    name: 'read_file',
    description: 'Read a file or list a directory. Path governance is handled by the Loop policy.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path (~ expands to home)' }
      },
      required: ['path']
    },
    execute: async ({ path }, ctx) => {
      const result = readFile(path, ctx.senderId);
      return result.output;
    }
  },
  {
    name: 'send_file',
    description: 'Send a file to the current chat. Use when the user asks for a file, screenshot, or when output is better as an attachment.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to send (~ expands to home)' },
        caption: { type: 'string', description: 'Optional caption for the file' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath, caption }, ctx) => {
      const fs = require('fs');
      const resolved = (filePath || '').replace(/^~/, process.env.HOME || '');
      if (!fs.existsSync(resolved)) return `File not found: ${filePath}`;
      if (!ctx.platform?.sendFile) return 'File sending not supported on this platform.';
      await ctx.platform.sendFile(ctx.chatId, resolved, caption);
      return `Sent: ${require('path').basename(resolved)}`;
    }
  },
  {
    name: 'grep_files',
    description: 'Search file contents using grep. Finds lines matching a pattern in files under a directory. Use when the user wants to find text inside files on disk (not indexed documents).',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (~ expands to home). Default: ~' },
        options: { type: 'string', description: 'Extra grep flags, e.g. "-i" for case-insensitive, "-l" for filenames only' }
      },
      required: ['pattern']
    },
    execute: async ({ pattern, path: searchPath, options: flags }, ctx) => {
      const dir = (searchPath || '~').replace(/^~/, process.env.HOME || '');
      // argv, no shell: pattern/dir/flags reach grep literally, so `$()`, `;`,
      // backticks etc. cannot inject. `--` terminates flags so a pattern
      // starting with `-` is treated as the pattern, not an option. Still
      // allowlist the flags: an arbitrary grep option (`-f <file>`, `--include`,
      // `-r /`) is a read-amplification / behavior-change vector. Permit only the
      // safe short flags (combinable, e.g. `-rn`, `-rni`).
      const optArgs = (flags || '-rn').split(/\s+/).filter(Boolean);
      if (!optArgs.every((f) => /^-[rniwlcH]+$/.test(f))) return 'Unsupported grep option.';
      const result = await execArgv('grep', [...optArgs, '--', pattern, dir], ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output || 'No matches found.';
    }
  },
  {
    name: 'find_files',
    description: 'Find files by name. Matching is case-insensitive and substring by default, so "amr-hassan-resume" finds "amr-hassan-resume.txt" — pass just the distinctive part of the name. An explicit glob (containing * ? or [ ]) is used as-is. Searches recursively; defaults to the home directory.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filename, a distinctive substring of it, or a glob (e.g. "resume", "blueprint.md", "*.pdf")' },
        path: { type: 'string', description: 'Directory to search in (~ expands to home). Default: ~' }
      },
      required: ['name']
    },
    execute: async ({ name, path: searchPath }, ctx) => {
      const dir = (searchPath || '~').replace(/^~/, process.env.HOME || '');
      // `find` has no `--`, and a leading-`-` argument is parsed as an EXPRESSION
      // / action (`-delete`, `-fprint <file>`, …), not a path — a path-arg
      // injection that turns this read tool into a destructive primitive. Reject
      // any path that find could read as an option. (`$()`/backticks are already
      // inert: execArgv runs no shell.)
      if (/^-/.test(dir)) return 'Invalid path.';
      // Case-insensitive substring by default (-iname '*name*') so a partial name
      // matches the real file incl. its extension; honor an explicit glob as-is.
      const hasGlob = /[*?[\]]/.test(name);
      const pattern = hasGlob ? name : `*${name}*`;
      const result = await execArgv('find', [dir, '-maxdepth', '6', '-iname', pattern], ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output || 'No files found.';
    }
  },
  {
    name: 'search_docs',
    description: 'Search indexed documents (PDFs, DOCX, etc.) for relevant information. Returns matching excerpts with sources.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    },
    execute: async ({ query }, ctx) => {
      if (!ctx.indexer) return 'Document indexer not available.';
      // Owner recalls admin ∪ global-KB; a customer recalls own ∪ global-KB. litectx
      // recall(scope) returns scope ∪ null-global, so a customer-planted chunk can't
      // enter the owner's (or another customer's) agent context (#6).
      const scope = ctx.isOwner ? 'admin' : `user:${ctx.chatId}`;
      const results = await ctx.indexer.search(query, { scope, n: 5 });
      if (results.length === 0) return 'No matching documents found.';
      return results.map((r, i) => {
        const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
        return `[${i + 1}] ${r.name}: ${preview}`;
      }).join('\n\n');
    }
  },
  {
    name: 'recall_memory',
    description: 'Search your memory of past conversations. Use when the user references something discussed before ("do you remember...", "what did I say about...", "my wife\'s name"), or when answering requires personal context. This searches conversation summaries, NOT documents.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory' }
      },
      required: ['query']
    },
    execute: async ({ query }, ctx) => {
      if (!ctx.indexer) return 'Memory search not available.';
      // Owner memory lives under scope 'admin'; a customer's under 'user:<chatId>'.
      // recallMemory fences to scope ∪ global over the fact/episode kinds (never docs),
      // so a customer can't read owner memory (#6).
      const scope = ctx.isOwner ? 'admin' : `user:${ctx.chatId}`;
      const results = await ctx.indexer.recallMemory(query, { scope, n: 5 });
      if (results.length === 0) return 'No matching memories found.';
      const fmt = (r, i) => {
        const date = r.createdAt?.slice(0, 10) || 'unknown date';
        return `[${i + 1}] ${date}: ${r.content.slice(0, 500)}`;
      };
      return results.map(fmt).join('\n\n');
    }
  },
  {
    name: 'remember',
    description: 'Save a note to persistent memory for this conversation. Use when the user asks to remember something.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note to remember' }
      },
      required: ['note']
    },
    execute: async ({ note }, ctx) => {
      if (!ctx.indexer) return 'Memory not available.';
      // A deliberate note → a durable fact (by:'human', top trust), tenant-fenced. W4: if it
      // RESTATES-AND-UPDATES an existing fact, overwrite that one in place rather than pile up a
      // contradiction (degrades to a plain new-fact write when superseding is off / no provider).
      const scope = ctx.isOwner ? 'admin' : `user:${ctx.chatId}`;
      await rememberWithSupersede({ indexer: ctx.indexer, provider: ctx.provider, scope, note, memCfg: ctx.config?.memory });
      return 'Noted.';
    }
  },

  {
    name: 'escalate',
    description: 'Escalate a conversation to the admin/owner for human attention. Use when you cannot resolve the customer\'s issue, when they request a human, or when the situation requires human judgment (refunds, complaints, urgent matters).',
    platforms: ['linux', 'macos'],
    owner_only: false,
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this needs human attention' },
        urgency: { type: 'string', enum: ['normal', 'urgent'], description: 'Urgency level (default: normal)' }
      },
      required: ['reason']
    },
    execute: async ({ reason, urgency }, ctx) => {
      const customerName = ctx.config?.chats?.[ctx.chatId]?.name || ctx.chatId;
      const tag = urgency === 'urgent' ? '[URGENT] ' : '';
      const notification = `${tag}[Escalation] ${customerName}: ${reason}`;

      // Optional override: send to a single specific chat
      const override = ctx.config?.business?.escalation?.admin_chat;
      if (override) {
        if (ctx.platform?.send) await ctx.platform.send(override, notification);
        return 'Admin notified. Continue responding naturally to the customer.';
      }

      // Send to all admin channels
      let sent = 0;
      const registry = ctx.platformRegistry;
      if (registry) {
        for (const [name, plat] of registry) {
          if (name === 'telegram' && ctx.config?.owner_id) {
            await plat.send(ctx.config.owner_id, notification);
            sent++;
          } else if (name === 'beeper' && plat.getAdminChatIds) {
            for (const chatId of plat.getAdminChatIds()) {
              await plat.send(chatId, notification);
              sent++;
            }
          }
        }
      }
      if (sent === 0) return 'Escalation noted, but no admin channels available. Tell the customer someone will follow up.';
      return 'Admin notified. Continue responding naturally to the customer.';
    }
  },

  // -------------------------------------------------------------------------
  // Desktop tools (linux + macos)
  // -------------------------------------------------------------------------
  {
    name: 'open_url',
    description: 'Open a URL in the default browser.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' }
      },
      required: ['url']
    },
    execute: async ({ url }, ctx) => {
      const cmds = { linux: 'xdg-open', macos: 'open' };
      const cmd = cmds[ctx.runtimePlatform];
      if (!cmd) return `Unsupported platform: ${ctx.runtimePlatform}`;
      const result = await execArgv(cmd, [url], ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Opened: ${url}` : result.output;
    }
  },
  {
    name: 'media_control',
    description: 'Control media playback — play, pause, next, previous, or set volume.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: MEDIA_ACTIONS, description: 'Playback action' },
        volume: { type: 'number', description: 'Set volume percentage (0-100). Omit for playback actions.' }
      },
      required: []
    },
    execute: async ({ action, volume }, ctx) => {
      if (volume !== undefined) {
        // Clamp to a finite 0-100 integer — never interpolate a model-supplied
        // value into a command; run via argv (no shell) for good measure.
        const v = Math.round(Number(volume));
        if (!Number.isFinite(v) || v < 0 || v > 100) return 'Volume must be 0-100.';
        const result = ctx.runtimePlatform === 'linux'
          ? await execArgv('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${v}%`], ctx.senderId)
          : await execArgv('osascript', ['-e', `set volume output volume ${v}`], ctx.senderId);
        if (result.denied) return `Denied: ${result.reason}`;
        return result.success ? `Volume set to ${v}%` : result.output;
      }
      if (!action) return 'Specify an action (play, pause, next, previous) or a volume.';
      // The model is assumed compromised by content injection, and the schema enum
      // is NOT enforced at the adapter — validate against the allowlist BEFORE the
      // value reaches a command, and run via argv (no shell). Closes the prior
      // `playerctl ${action}` injection (`action:"pause; touch X"` → RCE).
      if (!MEDIA_ACTIONS.includes(action)) return `Invalid action. Use one of: ${MEDIA_ACTIONS.join(', ')}.`;
      const result = ctx.runtimePlatform === 'linux'
        ? await execArgv('playerctl', [action], ctx.senderId)
        : await execArgv('osascript', ['-e', `tell application "Music" to ${action === 'play-pause' ? 'playpause' : action}`], ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Media: ${action}` : result.output;
    }
  },
  {
    name: 'notify',
    description: 'Show a desktop or phone notification.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        message: { type: 'string', description: 'Notification body' }
      },
      required: ['message']
    },
    execute: async ({ title, message }, ctx) => {
      const t = title || 'multis';
      // execArgv (no shell): title/message reach the program as literal argv.
      // macos osascript embeds them as AppleScript string literals via
      // JSON.stringify (double-quoted, escaped) — safe now that no shell parses it.
      let result;
      if (ctx.runtimePlatform === 'linux') {
        result = await execArgv('notify-send', [t, message], ctx.senderId);
      } else if (ctx.runtimePlatform === 'macos') {
        const osa = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(t)}`;
        result = await execArgv('osascript', ['-e', osa], ctx.senderId);
      } else {
        return `Unsupported platform: ${ctx.runtimePlatform}`;
      }
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? 'Notification sent.' : result.output;
    }
  },
  {
    name: 'clipboard',
    description: 'Get or set the clipboard contents.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'Get or set clipboard' },
        text: { type: 'string', description: 'Text to copy (required for set)' }
      },
      required: ['action']
    },
    execute: async ({ action, text }, ctx) => {
      if (action === 'set') {
        if (!text) return 'Text required for clipboard set.';
        // Pipe needs a shell; shq() makes the user text injection-safe.
        const cmds = {
          linux: `printf '%s' ${shq(text)} | xclip -selection clipboard`,
          macos: `printf '%s' ${shq(text)} | pbcopy`
        };
        const cmd = cmds[ctx.runtimePlatform];
        if (!cmd) return `Unsupported platform: ${ctx.runtimePlatform}`;
        const result = await execCommand(cmd, ctx.senderId);
        if (result.denied) return `Denied: ${result.reason}`;
        return result.success ? 'Copied to clipboard.' : result.output;
      }
      const cmds = {
        linux: 'xclip -selection clipboard -o',
        macos: 'pbpaste'
      };
      const cmd = cmds[ctx.runtimePlatform];
      const result = await execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot and save it.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        output: { type: 'string', description: 'Output file path (default: /tmp/screenshot.png)' }
      },
      required: []
    },
    execute: async ({ output }, ctx) => {
      const file = output || '/tmp/screenshot.png';
      const cmd = ctx.runtimePlatform === 'linux'
        ? `gnome-screenshot -f ${shq(file)} 2>/dev/null || grim ${shq(file)}`
        : `screencapture ${shq(file)}`;
      const result = await execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Screenshot saved to ${file}` : result.output;
    }
  },
  {
    name: 'system_info',
    description: 'Get system information — CPU load, memory usage, disk space, battery status.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (_input, ctx) => {
      const cmds = {
        linux: "echo '--- CPU ---' && uptime && echo '--- Memory ---' && free -h && echo '--- Disk ---' && df -h / && (upower -i /org/freedesktop/UPower/devices/battery_BAT0 2>/dev/null | grep -E 'percentage|state' || echo 'No battery')",
        macos: "echo '--- CPU ---' && uptime && echo '--- Memory ---' && vm_stat | head -5 && echo '--- Disk ---' && df -h / && echo '--- Battery ---' && pmset -g batt"
      };
      const cmd = cmds[ctx.runtimePlatform];
      if (!cmd) return `Unsupported platform: ${ctx.runtimePlatform}`;
      const result = await execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  },
  {
    name: 'wifi',
    description: 'List available WiFi networks or connect to one.',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'connect'], description: 'List networks or connect' },
        ssid: { type: 'string', description: 'Network name (required for connect)' },
        password: { type: 'string', description: 'Network password (for connect)' }
      },
      required: ['action']
    },
    execute: async ({ action, ssid, password }, ctx) => {
      if (action === 'list') {
        const cmd = ctx.runtimePlatform === 'linux'
          ? 'nmcli device wifi list'
          : "networksetup -listpreferredwirelessnetworks en0";
        const result = await execCommand(cmd, ctx.senderId);
        if (result.denied) return `Denied: ${result.reason}`;
        return result.output;
      }
      if (!ssid) return 'SSID required for connect.';
      // execArgv (no shell): ssid/password reach the program as literal argv.
      const [bin, args] = ctx.runtimePlatform === 'linux'
        ? ['nmcli', ['device', 'wifi', 'connect', ssid, ...(password ? ['password', password] : [])]]
        : ['networksetup', ['-setairportnetwork', 'en0', ssid, ...(password ? [password] : [])]];
      const result = await execArgv(bin, args, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Connected to ${ssid}` : result.output;
    }
  },
  {
    name: 'brightness',
    description: 'Adjust screen brightness (0-100).',
    platforms: ['linux', 'macos'],
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Brightness percentage (0-100)' }
      },
      required: ['level']
    },
    execute: async ({ level }, ctx) => {
      const pct = Math.max(0, Math.min(100, Math.round(level)));
      const cmd = ctx.runtimePlatform === 'linux'
        ? `brightnessctl set ${pct}%`
        : `brightness ${pct / 100}`;
      const result = await execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Brightness set to ${pct}%` : result.output;
    }
  },
];

module.exports = { TOOLS };
