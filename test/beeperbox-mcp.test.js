const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { BeeperboxMcpClient, BeeperboxMcpError } = require('../src/platforms/beeperbox-mcp');

// ---------------------------------------------------------------------------
// A fake fetch: records the request, returns a scripted response. The whole
// HTTP/JSON-RPC seam is injected, so these are deterministic and CI-safe (no
// live container). Behavior-level: we assert on the request multis SENDS and
// the value it RETURNS, not on internals.
// ---------------------------------------------------------------------------

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    const req = { url, opts, body: JSON.parse(opts.body) };
    calls.push(req);
    return responder(req);
  };
  fn.calls = calls;
  return fn;
}

// Build a Response-like object (only the bits the client uses).
function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// A tools/call result envelope as beeperbox returns it.
function toolResult(data) {
  return { result: { content: [{ type: 'text', text: JSON.stringify(data) }] }, jsonrpc: '2.0', id: 1 };
}

function client(fetchImpl, opts = {}) {
  return new BeeperboxMcpClient({ url: 'http://localhost:23375', fetchImpl, ...opts });
}

describe('BeeperboxMcpClient', () => {
  it('requires a url', () => {
    assert.throws(() => new BeeperboxMcpClient({}), BeeperboxMcpError);
  });

  it('normalizes a trailing-slash url and POSTs JSON-RPC 2.0 to the root', async () => {
    const f = fakeFetch(() => jsonResponse(toolResult({ ok: true })));
    const c = new BeeperboxMcpClient({ url: 'http://localhost:23375///', fetchImpl: f });
    await c.callTool('list_accounts', {});
    const req = f.calls[0];
    assert.equal(req.url, 'http://localhost:23375/');
    assert.equal(req.opts.method, 'POST');
    assert.equal(req.opts.headers['Content-Type'], 'application/json');
    assert.equal(req.body.jsonrpc, '2.0');
    assert.equal(req.body.method, 'tools/call');
    assert.deepEqual(req.body.params, { name: 'list_accounts', arguments: {} });
  });

  it('unwraps and parses the tool-result text payload', async () => {
    const f = fakeFetch(() => jsonResponse(toolResult({ accounts: 4, items: ['a'] })));
    const out = await client(f).callTool('list_accounts');
    assert.deepEqual(out, { accounts: 4, items: ['a'] });
  });

  it('increments the JSON-RPC id per call', async () => {
    const f = fakeFetch(() => jsonResponse(toolResult({})));
    const c = client(f);
    await c.callTool('a');
    await c.callTool('b');
    assert.equal(f.calls[0].body.id, 1);
    assert.equal(f.calls[1].body.id, 2);
  });

  it('sends a bearer token only when configured', async () => {
    const f1 = fakeFetch(() => jsonResponse(toolResult({})));
    await client(f1).callTool('x');
    assert.equal(f1.calls[0].opts.headers.Authorization, undefined);

    const f2 = fakeFetch(() => jsonResponse(toolResult({})));
    await client(f2, { token: 'sekret' }).callTool('x');
    assert.equal(f2.calls[0].opts.headers.Authorization, 'Bearer sekret');
  });

  it('surfaces a JSON-RPC error with its code', async () => {
    const f = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown tool: nope' } }));
    await assert.rejects(() => client(f).callTool('nope'), (err) => {
      assert.ok(err instanceof BeeperboxMcpError);
      assert.equal(err.code, -32601);
      assert.match(err.message, /unknown tool: nope/);
      return true;
    });
  });

  it('surfaces an HTTP error with the status code and body', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 502, text: async () => 'bad gateway' }));
    await assert.rejects(() => client(f).callTool('x'), (err) => {
      assert.equal(err.code, 502);
      assert.match(err.message, /HTTP 502/);
      assert.match(err.message, /bad gateway/);
      return true;
    });
  });

  it('wraps a network failure (no silent swallow)', async () => {
    const f = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(() => client(f).callTool('x'), (err) => {
      assert.ok(err instanceof BeeperboxMcpError);
      assert.match(err.message, /request failed.*ECONNREFUSED/);
      return true;
    });
  });

  it('ACTUALLY aborts a hanging request via AbortController (mechanism, not a faked throw)', async () => {
    // fetch that never resolves until the client aborts it — exercises the real
    // setTimeout -> ctrl.abort() -> signal wiring, not just message formatting.
    let abortFired = false;
    const hanging = (_url, opts) => new Promise((_resolve, reject) => {
      assert.ok(opts.signal, 'client must pass an abort signal to fetch');
      opts.signal.addEventListener('abort', () => {
        abortFired = true;
        const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e);
      });
    });
    const c = new BeeperboxMcpClient({ url: 'http://x', fetchImpl: hanging, timeout: 20 });
    await assert.rejects(() => c.callTool('slow'), /timeout after 20ms/);
    assert.equal(abortFired, true, 'the client must have called abort() on the signal');
  });

  it('raises on a non-JSON response body', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); }, text: async () => 'oops' }));
    await assert.rejects(() => client(f).callTool('x'), /non-JSON/);
  });

  it('treats an MCP isError result as an error — never parses it as data', async () => {
    const f = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'tool blew up' }] } }));
    await assert.rejects(() => client(f).callTool('x'), (err) => {
      assert.ok(err instanceof BeeperboxMcpError);
      assert.match(err.message, /tool error.*tool blew up/);
      return true;
    });
  });

  it('returns the raw result when content is empty (nothing to unwrap)', async () => {
    const f = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
    assert.deepEqual(await client(f).callTool('x'), { content: [] });
  });

  it('returns "" for an empty-string text payload (unparseable, but not an error)', async () => {
    const f = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '' }] } }));
    assert.equal(await client(f).callTool('x'), '');
  });

  it('returns [] from listTools when none present, else the tools array', async () => {
    const empty = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    assert.deepEqual(await client(empty).listTools(), []);
    const some = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'poll_messages' }] } }));
    assert.deepEqual(await client(some).listTools(), [{ name: 'poll_messages' }]);
  });

  describe('verb wrappers shape arguments correctly', () => {
    it('pollMessages omits undefined fields (seed = no cursor)', async () => {
      const f = fakeFetch(() => jsonResponse(toolResult({ cursor: 'c', messages: [], seeded: true })));
      const c = client(f);
      await c.pollMessages();
      assert.deepEqual(f.calls[0].body.params, { name: 'poll_messages', arguments: {} });
      await c.pollMessages({ cursor: 'abc', limit: 100 });
      assert.deepEqual(f.calls[1].body.params.arguments, { cursor: 'abc', limit: 100 });
    });

    it('sendMessage always carries chat_id + text, client_tag when given', async () => {
      const f = fakeFetch(() => jsonResponse(toolResult({ status: 'sent' })));
      const c = client(f);
      await c.sendMessage({ chat_id: '!x', text: 'hi', client_tag: 't1' });
      assert.deepEqual(f.calls[0].body.params.arguments, { chat_id: '!x', text: 'hi', client_tag: 't1' });
      await c.sendMessage({ chat_id: '!x', text: 'hi' });
      assert.deepEqual(f.calls[1].body.params.arguments, { chat_id: '!x', text: 'hi' });
    });

    it('noteToSelf carries text + optional client_tag', async () => {
      const f = fakeFetch(() => jsonResponse(toolResult({ status: 'sent' })));
      await client(f).noteToSelf({ text: 'note', client_tag: 'n1' });
      assert.deepEqual(f.calls[0].body.params, { name: 'note_to_self', arguments: { text: 'note', client_tag: 'n1' } });
    });
  });
});
