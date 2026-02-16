/**
 * Tool definitions — name, description, input_schema, platforms, execute fn.
 *
 * Each tool has:
 *   name        — unique identifier sent to LLM
 *   description — what the LLM sees (guides tool selection)
 *   platforms   — which platforms support it ['linux','macos','android']
 *   input_schema— JSON Schema for parameters
 *   execute     — async (input, ctx) => string result
 *
 * ctx has: { senderId, chatId, isOwner, platform (runtime), indexer, memoryManager }
 */

const { execCommand, readFile } = require('../skills/executor');

const TOOLS = [
  // -------------------------------------------------------------------------
  // Universal tools (all platforms)
  // -------------------------------------------------------------------------
  {
    name: 'exec',
    description: 'Run a shell command on the local machine. Goes through governance allowlist. Use for system tasks, opening apps, checking status, etc.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' }
      },
      required: ['command']
    },
    execute: async ({ command }, ctx) => {
      const result = execCommand(command, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      if (result.needsConfirmation) return `Command "${command}" requires confirmation.`;
      return result.output;
    }
  },
  {
    name: 'read_file',
    description: 'Read a file or list a directory. Use to check file contents, configs, logs.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path (~ expands to home)' }
      },
      required: ['path']
    },
    execute: async ({ path }, ctx) => {
      const result = readFile(path, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  },
  {
    name: 'grep_files',
    description: 'Search file contents using grep. Finds lines matching a pattern in files under a directory. Use when the user wants to find text inside files on disk (not indexed documents).',
    platforms: ['linux', 'macos', 'android'],
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
      const opts = flags || '-rn';
      const cmd = `grep ${opts} ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`;
      const result = execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output || 'No matches found.';
    }
  },
  {
    name: 'find_files',
    description: 'Find files by name pattern. Use when the user wants to locate a file on disk by its filename.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filename or glob pattern (e.g. "blueprint.md", "*.pdf")' },
        path: { type: 'string', description: 'Directory to search in (~ expands to home). Default: ~' }
      },
      required: ['name']
    },
    execute: async ({ name, path: searchPath }, ctx) => {
      const dir = (searchPath || '~').replace(/^~/, process.env.HOME || '');
      const cmd = `find ${JSON.stringify(dir)} -maxdepth 5 -name ${JSON.stringify(name)} 2>/dev/null`;
      const result = execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output || 'No files found.';
    }
  },
  {
    name: 'search_docs',
    description: 'Search indexed documents (PDFs, DOCX, etc.) for relevant information. Returns matching excerpts with sources.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    },
    execute: async ({ query }, ctx) => {
      if (!ctx.indexer) return 'Document indexer not available.';
      const scopes = ctx.isOwner ? undefined : ['kb', `user:${ctx.chatId}`];
      const results = ctx.indexer.search(query, 5, { scopes });
      if (results.length === 0) return 'No matching documents found.';
      return results.map((r, i) => {
        const path = r.sectionPath?.join(' > ') || r.name;
        const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
        return `[${i + 1}] ${path}: ${preview}`;
      }).join('\n\n');
    }
  },
  {
    name: 'recall_memory',
    description: 'Search your memory of past conversations. Use when the user references something discussed before ("do you remember...", "what did I say about...", "my wife\'s name"), or when answering requires personal context. This searches conversation summaries, NOT documents.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory' }
      },
      required: ['query']
    },
    execute: async ({ query }, ctx) => {
      if (!ctx.indexer) return 'Memory search not available.';
      const scopes = ctx.isOwner ? undefined : [`user:${ctx.chatId}`];
      const searchOpts = { scopes, types: ['memory_summary'] };
      // Try FTS search first; if empty (e.g. all stopwords), fall back to recent
      let results = ctx.indexer.store.search(query, 5, searchOpts);
      if (results.length === 0) {
        results = ctx.indexer.store.recentByType(5, searchOpts);
      }
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
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note to remember' }
      },
      required: ['note']
    },
    execute: async ({ note }, ctx) => {
      if (!ctx.memoryManager) return 'Memory not available.';
      ctx.memoryManager.appendMemory(note);
      return 'Noted.';
    }
  },

  // -------------------------------------------------------------------------
  // Desktop tools (linux + macos)
  // -------------------------------------------------------------------------
  {
    name: 'open_url',
    description: 'Open a URL in the default browser.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' }
      },
      required: ['url']
    },
    execute: async ({ url }, ctx) => {
      const cmds = { linux: 'xdg-open', macos: 'open', android: 'termux-open-url' };
      const cmd = cmds[ctx.runtimePlatform];
      if (!cmd) return `Unsupported platform: ${ctx.runtimePlatform}`;
      const result = execCommand(`${cmd} ${JSON.stringify(url)}`, ctx.senderId);
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
        action: { type: 'string', enum: ['play', 'pause', 'play-pause', 'next', 'previous', 'stop'], description: 'Playback action' },
        volume: { type: 'number', description: 'Set volume percentage (0-100). Omit for playback actions.' }
      },
      required: []
    },
    execute: async ({ action, volume }, ctx) => {
      if (volume !== undefined) {
        const cmd = ctx.runtimePlatform === 'linux'
          ? `pactl set-sink-volume @DEFAULT_SINK@ ${Math.round(volume)}%`
          : `osascript -e 'set volume output volume ${Math.round(volume)}'`;
        const result = execCommand(cmd, ctx.senderId);
        if (result.denied) return `Denied: ${result.reason}`;
        return result.success ? `Volume set to ${Math.round(volume)}%` : result.output;
      }
      if (!action) return 'Specify an action (play, pause, next, previous) or a volume.';
      const cmd = ctx.runtimePlatform === 'linux'
        ? `playerctl ${action}`
        : `osascript -e 'tell application "Music" to ${action === 'play-pause' ? 'playpause' : action}'`;
      const result = execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Media: ${action}` : result.output;
    }
  },
  {
    name: 'notify',
    description: 'Show a desktop or phone notification.',
    platforms: ['linux', 'macos', 'android'],
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
      const cmds = {
        linux: `notify-send ${JSON.stringify(t)} ${JSON.stringify(message)}`,
        macos: `osascript -e 'display notification ${JSON.stringify(message)} with title ${JSON.stringify(t)}'`,
        android: `termux-notification --title ${JSON.stringify(t)} --content ${JSON.stringify(message)}`
      };
      const cmd = cmds[ctx.runtimePlatform];
      if (!cmd) return `Unsupported platform: ${ctx.runtimePlatform}`;
      const result = execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? 'Notification sent.' : result.output;
    }
  },
  {
    name: 'clipboard',
    description: 'Get or set the clipboard contents.',
    platforms: ['linux', 'macos', 'android'],
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
        const cmds = {
          linux: `echo ${JSON.stringify(text)} | xclip -selection clipboard`,
          macos: `echo ${JSON.stringify(text)} | pbcopy`,
          android: `termux-clipboard-set ${JSON.stringify(text)}`
        };
        const cmd = cmds[ctx.runtimePlatform];
        const result = execCommand(cmd, ctx.senderId);
        if (result.denied) return `Denied: ${result.reason}`;
        return result.success ? 'Copied to clipboard.' : result.output;
      }
      const cmds = {
        linux: 'xclip -selection clipboard -o',
        macos: 'pbpaste',
        android: 'termux-clipboard-get'
      };
      const cmd = cmds[ctx.runtimePlatform];
      const result = execCommand(cmd, ctx.senderId);
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
        ? `gnome-screenshot -f ${JSON.stringify(file)} 2>/dev/null || grim ${JSON.stringify(file)}`
        : `screencapture ${JSON.stringify(file)}`;
      const result = execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Screenshot saved to ${file}` : result.output;
    }
  },
  {
    name: 'system_info',
    description: 'Get system information — CPU load, memory usage, disk space, battery status.',
    platforms: ['linux', 'macos', 'android'],
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (_input, ctx) => {
      const cmds = {
        linux: "echo '--- CPU ---' && uptime && echo '--- Memory ---' && free -h && echo '--- Disk ---' && df -h / && (upower -i /org/freedesktop/UPower/devices/battery_BAT0 2>/dev/null | grep -E 'percentage|state' || echo 'No battery')",
        macos: "echo '--- CPU ---' && uptime && echo '--- Memory ---' && vm_stat | head -5 && echo '--- Disk ---' && df -h / && echo '--- Battery ---' && pmset -g batt",
        android: 'termux-battery-status'
      };
      const cmd = cmds[ctx.runtimePlatform];
      if (!cmd) return `Unsupported platform: ${ctx.runtimePlatform}`;
      const result = execCommand(cmd, ctx.senderId);
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
        const result = execCommand(cmd, ctx.senderId);
        if (result.denied) return `Denied: ${result.reason}`;
        return result.output;
      }
      if (!ssid) return 'SSID required for connect.';
      const cmd = ctx.runtimePlatform === 'linux'
        ? `nmcli device wifi connect ${JSON.stringify(ssid)}${password ? ` password ${JSON.stringify(password)}` : ''}`
        : `networksetup -setairportnetwork en0 ${JSON.stringify(ssid)}${password ? ` ${JSON.stringify(password)}` : ''}`;
      const result = execCommand(cmd, ctx.senderId);
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
      const result = execCommand(cmd, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Brightness set to ${pct}%` : result.output;
    }
  },

  // -------------------------------------------------------------------------
  // Android tools (Termux)
  // -------------------------------------------------------------------------
  {
    name: 'phone_call',
    description: 'Make a phone call to a number.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Phone number to call' }
      },
      required: ['number']
    },
    execute: async ({ number }, ctx) => {
      const result = execCommand(`termux-telephony-call ${JSON.stringify(number)}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Calling ${number}...` : result.output;
    }
  },
  {
    name: 'sms_send',
    description: 'Send an SMS message.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Phone number to send to' },
        message: { type: 'string', description: 'Message text' }
      },
      required: ['number', 'message']
    },
    execute: async ({ number, message }, ctx) => {
      const result = execCommand(`termux-sms-send -n ${JSON.stringify(number)} ${JSON.stringify(message)}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `SMS sent to ${number}` : result.output;
    }
  },
  {
    name: 'sms_list',
    description: 'Read recent SMS messages from inbox.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of messages to return (default 10)' }
      },
      required: []
    },
    execute: async ({ limit }, ctx) => {
      const n = limit || 10;
      const result = execCommand(`termux-sms-list -l ${n}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  },
  {
    name: 'contacts',
    description: 'List contacts from the phone.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (_input, ctx) => {
      const result = execCommand('termux-contact-list', ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  },
  {
    name: 'location',
    description: 'Get current GPS location.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (_input, ctx) => {
      const result = execCommand('termux-location -p network', ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  },
  {
    name: 'camera',
    description: 'Take a photo with the phone camera.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        camera: { type: 'number', description: 'Camera ID (0=back, 1=front). Default: 0' }
      },
      required: []
    },
    execute: async ({ camera }, ctx) => {
      const cam = camera || 0;
      const file = `/data/data/com.termux/files/home/photo_${Date.now()}.jpg`;
      const result = execCommand(`termux-camera-photo -c ${cam} ${file}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Photo saved: ${file}` : result.output;
    }
  },
  {
    name: 'tts',
    description: 'Speak text aloud using text-to-speech.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' }
      },
      required: ['text']
    },
    execute: async ({ text }, ctx) => {
      const result = execCommand(`termux-tts-speak ${JSON.stringify(text)}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? 'Speaking...' : result.output;
    }
  },
  {
    name: 'torch',
    description: 'Toggle the phone flashlight on or off.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true = on, false = off' }
      },
      required: ['enabled']
    },
    execute: async ({ enabled }, ctx) => {
      const result = execCommand(`termux-torch ${enabled ? 'on' : 'off'}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `Flashlight ${enabled ? 'on' : 'off'}` : result.output;
    }
  },
  {
    name: 'vibrate',
    description: 'Vibrate the phone.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        duration: { type: 'number', description: 'Duration in milliseconds (default 1000)' }
      },
      required: []
    },
    execute: async ({ duration }, ctx) => {
      const ms = duration || 1000;
      const result = execCommand(`termux-vibrate -d ${ms}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? 'Vibrated.' : result.output;
    }
  },
  {
    name: 'volume',
    description: 'Set phone volume (media, ring, or alarm).',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {
        stream: { type: 'string', enum: ['music', 'ring', 'alarm', 'notification'], description: 'Volume stream' },
        level: { type: 'number', description: 'Volume level (0-15)' }
      },
      required: ['stream', 'level']
    },
    execute: async ({ stream, level }, ctx) => {
      const result = execCommand(`termux-volume ${stream} ${level}`, ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.success ? `${stream} volume set to ${level}` : result.output;
    }
  },
  {
    name: 'battery',
    description: 'Get phone battery status.',
    platforms: ['android'],
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (_input, ctx) => {
      const result = execCommand('termux-battery-status', ctx.senderId);
      if (result.denied) return `Denied: ${result.reason}`;
      return result.output;
    }
  }
];

module.exports = { TOOLS };
