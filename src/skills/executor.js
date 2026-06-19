const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const { logAudit } = require('../governance/audit');
const { SECRET_ENV_KEYS } = require('../config');

const MAX_OUTPUT = 4000; // Telegram message limit ~4096 chars

// The bot's own secrets live in process.env (loadEnv reads .env). A child shell
// inherits them by default, so a command — especially one driven by the LLM
// agent path if prompt-injected — could `echo $ANTHROPIC_API_KEY` and exfiltrate
// them. Strip the credential keys (single source: config.SECRET_ENV_KEYS) from
// the exec child env; nothing a user runs via /exec needs the bot's credentials.
function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of SECRET_ENV_KEYS) delete env[k];
  return env;
}

/**
 * Execute a shell command. Governance (command allowlist/denylist) is handled
 * by the bareguard Gate (wired via bare-agent's wireGate), not here.
 * Async (non-blocking) so a long-running command never stalls the single event
 * loop — a blocking `execSync` here would starve the beeperbox MCP poller/sender
 * and trip its request timeout.
 * @param {string} command - Full command string
 * @param {number} userId - User ID for audit
 * @returns {Promise<Object>} - { success, output }
 */
async function execCommand(command, userId) {
  try {
    const { stdout } = await execAsync(command, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/bash',
      env: scrubbedEnv()
    });

    const trimmed = stdout.length > MAX_OUTPUT
      ? stdout.slice(0, MAX_OUTPUT) + '\n... (truncated)'
      : stdout;

    logAudit({ action: 'exec', user_id: userId, command, status: 'success' });
    return { success: true, output: trimmed || '(no output)' };
  } catch (err) {
    const stderr = err.stderr || err.message;
    logAudit({ action: 'exec', user_id: userId, command, status: 'error', error: stderr });
    return { success: false, output: `Error: ${stderr}` };
  }
}

/**
 * Run a command as an argv array with NO shell. Use this for any command that
 * embeds caller/LLM-supplied arguments (filenames, patterns, flags): because no
 * shell parses the line, metacharacters like `$()`, backticks, `;`, `|` are
 * inert — they reach the program as literal argv, closing the shell-injection
 * class that string interpolation (even via JSON.stringify, which does NOT
 * escape `$` or backticks) leaves open.
 * @param {string} file - Executable name (resolved via PATH)
 * @param {string[]} args - Arguments, passed verbatim as argv
 * @param {number} userId - User ID for audit
 * @returns {Promise<Object>} - { success, output }
 */
async function execArgv(file, args, userId) {
  const display = `${file} ${args.join(' ')}`;
  const clamp = (s) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n... (truncated)' : s);
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: scrubbedEnv()
    });
    logAudit({ action: 'exec', user_id: userId, command: display, status: 'success' });
    return { success: true, output: clamp(stdout) || '(no output)' };
  } catch (err) {
    // find/grep exit non-zero on unreadable entries or no-match while still
    // producing valid results — surface partial stdout instead of erroring.
    if (err.stdout) {
      logAudit({ action: 'exec', user_id: userId, command: display, status: 'success' });
      return { success: true, output: clamp(err.stdout) };
    }
    // grep exit 1 == "no lines matched": a clean empty result, not an error.
    if (path.basename(file) === 'grep' && err.code === 1) {
      logAudit({ action: 'exec', user_id: userId, command: display, status: 'success' });
      return { success: true, output: '' };
    }
    const stderr = err.stderr || err.message;
    logAudit({ action: 'exec', user_id: userId, command: display, status: 'error', error: stderr });
    return { success: false, output: `Error: ${stderr}` };
  }
}

/**
 * Read a file or list a directory. Path governance is handled by the bareguard
 * Gate (wired via bare-agent's wireGate), not here.
 * @param {string} filePath - Path to read
 * @param {number} userId - User ID for audit
 * @returns {Object} - { success, output }
 */
function readFile(filePath, userId) {
  const expanded = filePath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);
  const resolved = path.resolve(expanded);

  try {
    if (!fs.existsSync(resolved)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved);
      const output = entries.join('\n') || '(empty directory)';
      const trimmed = output.length > MAX_OUTPUT
        ? output.slice(0, MAX_OUTPUT) + '\n... (truncated)'
        : output;
      logAudit({ action: 'read', user_id: userId, path: filePath, type: 'directory' });
      return { success: true, output: trimmed };
    }

    if (stat.size > 512 * 1024) {
      return { success: false, output: `File too large: ${(stat.size / 1024).toFixed(0)}KB (max 512KB)` };
    }

    const content = fs.readFileSync(resolved, 'utf8');
    const trimmed = content.length > MAX_OUTPUT
      ? content.slice(0, MAX_OUTPUT) + '\n... (truncated)'
      : content;

    logAudit({ action: 'read', user_id: userId, path: filePath, type: 'file' });
    return { success: true, output: trimmed || '(empty file)' };
  } catch (err) {
    logAudit({ action: 'read', user_id: userId, path: filePath, status: 'error', error: err.message });
    return { success: false, output: `Error: ${err.message}` };
  }
}

/**
 * List available skills from skills/ directory
 * @returns {string} - Formatted skill list
 */
function listSkills() {
  const skillsDir = path.join(__dirname, '..', '..', 'skills');

  if (!fs.existsSync(skillsDir)) {
    return 'No skills directory found.';
  }

  const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
  const skills = files.map(f => {
    const content = fs.readFileSync(path.join(skillsDir, f), 'utf8');
    // Parse frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return `- ${f}`;
    const name = (match[1].match(/name:\s*(.+)/) || [])[1] || f;
    const desc = (match[1].match(/description:\s*(.+)/) || [])[1] || '';
    return `- ${name}: ${desc}`;
  });

  return skills.join('\n') || 'No skills found.';
}

module.exports = { execCommand, execArgv, readFile, listSkills };
