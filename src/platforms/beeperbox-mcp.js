// Minimal JSON-RPC 2.0 client for beeperbox's MCP HTTP transport.
//
// beeperbox exposes the Beeper watch/send *verbs* as MCP tools over a plain
// HTTP transport (POST JSON-RPC 2.0, stateless — no `initialize` handshake).
// This is multis's consumer of those verbs. Vanilla `fetch`, NO MCP SDK — the
// transport is simple enough that the dependency hierarchy says stdlib/global
// fetch suffices (validated against the live container, M-B step 3).
//
// Tool results arrive wrapped as `{ content: [{ type:'text', text: <JSON> }] }`;
// `callTool` unwraps and parses the inner value. Boundary: verbs live in
// beeperbox, policy lives in multis (PRD §E) — this client only invokes verbs.

class BeeperboxMcpError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'BeeperboxMcpError';
    if (code !== undefined) this.code = code; // JSON-RPC or HTTP status code
    if (cause) this.cause = cause;
  }
}

class BeeperboxMcpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url      beeperbox MCP base URL (e.g. http://localhost:23375)
   * @param {string} [opts.token]  bearer token, if beeperbox sets MCP_AUTH_TOKEN
   * @param {number} [opts.timeout=15000]  per-request timeout (ms)
   * @param {Function} [opts.fetchImpl]    injectable fetch (tests); defaults to global
   */
  constructor({ url, token, timeout = 15000, fetchImpl } = {}) {
    if (!url) throw new BeeperboxMcpError('BeeperboxMcpClient: url is required');
    this.url = url.replace(/\/+$/, '') + '/'; // POST to the root path
    this.token = token || null;
    this.timeout = timeout;
    this._fetch = fetchImpl || globalThis.fetch;
    this._id = 0;
  }

  async _rpc(method, params) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method, params });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    // The timeout spans the WHOLE request — including the response-body read.
    // download_asset payloads ride base64 in the body, so a server that sends
    // headers then stalls the body must still abort; hence the signal stays
    // live and clearTimeout only fires in the outer finally (not right after
    // headers arrive).
    try {
      let res;
      try {
        res = await this._fetch(this.url, { method: 'POST', headers, body, signal: ctrl.signal });
      } catch (err) {
        const reason = err.name === 'AbortError' ? `timeout after ${this.timeout}ms` : err.message;
        throw new BeeperboxMcpError(`beeperbox MCP request failed (${method}): ${reason}`, { cause: err });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new BeeperboxMcpError(`beeperbox MCP HTTP ${res.status} (${method}): ${text.slice(0, 200)}`, { code: res.status });
      }
      let json;
      try {
        json = await res.json();
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new BeeperboxMcpError(`beeperbox MCP request failed (${method}): timeout after ${this.timeout}ms`, { cause: err });
        }
        throw new BeeperboxMcpError(`beeperbox MCP returned non-JSON (${method})`, { cause: err });
      }
      if (json.error) {
        throw new BeeperboxMcpError(`beeperbox MCP error (${method}): ${json.error.code} ${json.error.message}`, { code: json.error.code });
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Call a beeperbox MCP tool by name; returns the parsed tool-result value. */
  async callTool(name, args = {}) {
    const result = await this._rpc('tools/call', { name, arguments: args });
    // MCP tool-level error: a *successful* JSON-RPC response carrying isError.
    // beeperbox reports failures as JSON-RPC errors (handled in _rpc), but honor
    // the MCP contract so a tool error is never silently parsed as data.
    if (result?.isError) {
      const detail = result?.content?.[0]?.text;
      throw new BeeperboxMcpError(`beeperbox tool error (${name}): ${detail || 'unknown'}`);
    }
    const text = result?.content?.[0]?.text;
    if (text === undefined) return result; // non-text content — hand back as-is
    try {
      return JSON.parse(text);
    } catch {
      return text; // tool returned plain (non-JSON) text
    }
  }

  /** List the tools beeperbox exposes (connection / contract check). */
  async listTools() {
    const result = await this._rpc('tools/list', {});
    return result?.tools || [];
  }

  // ── thin verb wrappers (the ones multis composes; args pass through) ──

  /** Passive new-messages-since-cursor feed. Omit cursor to seed "from now". */
  pollMessages({ cursor, chat_id, limit } = {}) {
    const args = {};
    if (cursor !== undefined) args.cursor = cursor;
    if (chat_id !== undefined) args.chat_id = chat_id;
    if (limit !== undefined) args.limit = limit;
    return this.callTool('poll_messages', args);
  }

  /** Send to a chat. client_tag echoes back + marks the read-back source:"api". */
  sendMessage({ chat_id, text, client_tag, reply_to_message_id } = {}) {
    const args = { chat_id, text };
    if (client_tag !== undefined) args.client_tag = client_tag;
    if (reply_to_message_id !== undefined) args.reply_to_message_id = reply_to_message_id;
    return this.callTool('send_message', args);
  }

  /** Send to the bot's own Note-to-self chat (auto-resolves the chat id). */
  noteToSelf({ text, client_tag } = {}) {
    const args = { text };
    if (client_tag !== undefined) args.client_tag = client_tag;
    return this.callTool('note_to_self', args);
  }

  /** Connected accounts (self-id discovery / liveness check). */
  listAccounts() {
    return this.callTool('list_accounts', {});
  }
}

module.exports = { BeeperboxMcpClient, BeeperboxMcpError };
