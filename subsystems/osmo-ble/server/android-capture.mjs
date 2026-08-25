// Minimal MCP-over-HTTP client for an android-remote-control-mcp device, so the backend can
// take a photo on the phone mounted in the gimbal without a human driving an MCP client.
//
// Why a hand-rolled client rather than @modelcontextprotocol/sdk: the SDK's client is built
// around long-lived sessions, and a long-lived session is exactly what we must not hold here.
// The device caps concurrent MCP sessions and returns `503 {"error":"Too many active
// sessions"}` when the cap is reached — verified live 2026-08-24, where a Claude Code session
// already attached to the same phone made every backend `initialize` fail. So this opens a
// session, does its work, and DELETEs it, keeping the slot occupied only for the duration of a
// capture. It is still mutually exclusive with an attached Claude Code session; see
// docs/operations/GIMBAL_INTEGRATION.md.
//
// Probed the same day: with a valid bearer token, every path on the device except `/mcp`,
// `/health`, and the `/s/<hash>` share URLs returns 404. There is no REST alternative to fall
// back on, which is why the session cap has to be designed around rather than avoided.

const PROTOCOL_VERSION = '2025-06-18';

/**
 * A streamable-HTTP MCP response is either a plain JSON body or an SSE stream carrying one
 * `data:` line per message, depending on what the server decides. Accept both rather than
 * pinning one — the device has been observed using SSE framing for tool calls and plain JSON
 * for `initialize`.
 */
function parseMcpBody(contentType, text) {
  if ((contentType || '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload) return JSON.parse(payload);
      }
    }
    throw new Error('SSE response carried no data: line');
  }
  return text ? JSON.parse(text) : {};
}

export class AndroidMcpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url    e.g. http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp
   * @param {string} opts.token  bearer token from that device's Settings -> Access
   */
  constructor({ url, token }) {
    if (!url) throw new Error('AndroidMcpClient: url is required');
    if (!token) throw new Error('AndroidMcpClient: token is required (see .env.example ANDROID_MCP_TOKEN_*)');
    this._url = url;
    this._token = token;
    this._sessionId = null;
    this._nextId = 1;
  }

  _headers(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this._token}`,
      ...extra,
    };
    if (this._sessionId) h['Mcp-Session-Id'] = this._sessionId;
    return h;
  }

  async _post(body, { expectResult = true } = {}) {
    const res = await fetch(this._url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status === 503) {
      throw new Error(
        'device reports "Too many active sessions" — it caps concurrent MCP clients, and something else is holding a slot. ' +
        'A Claude Code session attached to this phone is the usual cause; detach it (or /mcp disconnect that server) and retry.'
      );
    }
    if (!res.ok) throw new Error(`device MCP returned HTTP ${res.status}: ${text.slice(0, 200)}`);

    const sid = res.headers.get('mcp-session-id');
    if (sid) this._sessionId = sid;
    if (!expectResult) return null;

    const msg = parseMcpBody(res.headers.get('content-type'), text);
    if (msg.error) throw new Error(`device MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  async open() {
    const result = await this._post({
      jsonrpc: '2.0',
      id: this._nextId++,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'osmo-ble-backend', version: '1' } },
    });
    // Required by the spec before any tool call; it is a notification, so no response body.
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResult: false });
    return result;
  }

  async callTool(name, args = {}) {
    const result = await this._post({
      jsonrpc: '2.0',
      id: this._nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    // Tool errors come back as a normal result with isError set, not as a JSON-RPC error.
    const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) throw new Error(`tool ${name} failed: ${text.slice(0, 300)}`);
    return text;
  }

  /**
   * Best-effort session teardown. Deliberately swallows failures: a capture that succeeded
   * must not be reported as failed because the cleanup DELETE was refused, and the device
   * expires idle sessions on its own anyway.
   */
  async close() {
    if (!this._sessionId) return;
    try {
      await fetch(this._url, { method: 'DELETE', headers: this._headers() });
    } catch {
      /* device will expire the session itself */
    }
    this._sessionId = null;
  }
}

/**
 * Capture one photo on the device and return a fetchable URL for it.
 *
 * Two tool calls rather than one because the device's `android_take_camera_photo` returns the
 * image inline as base64 in the MCP response, which would mean holding whole JPEGs in the
 * backend's memory and re-encoding them. `save_camera_photo` + `share_file_via_web` instead
 * leaves the bytes on the phone and hands back a plain HTTP URL the caller can stream from.
 */
export async function capturePhoto(client, { path, cameraId = '0', resolution = '1280x720', quality = 85, locationId = 'builtin:pictures' }) {
  await client.callTool('android_save_camera_photo', {
    camera_id: cameraId,
    location_id: locationId,
    path,
    resolution,
    quality,
  });
  const shared = await client.callTool('android_share_file_via_web', { location_id: locationId, path });
  const url = (shared.match(/https?:\/\/\S+/) || [])[0];
  if (!url) throw new Error(`could not find a share URL in the device response: ${shared.slice(0, 200)}`);
  return url;
}

/**
 * Serpentine ordering: each row is traversed opposite to the one before it, so the gimbal never
 * has to swing back across the full pan range between rows. Measured on a real run, the first
 * position of row 2 converged in 3 ticks against 7-26 for the rest, precisely because it starts
 * where row 1 ended.
 */
export function planGrid({ pans, tilts }) {
  const grid = [];
  tilts.forEach((tilt, row) => {
    const order = row % 2 === 0 ? pans : [...pans].reverse();
    for (const pan of order) grid.push({ pan, tilt });
  });
  return grid;
}
