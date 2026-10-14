import type { ServerWebSocket } from "bun";
import {
  isDeviceToServer,
  type CommandArgs,
  type CommandName,
  type DeviceInfo,
  type ResultMsg,
} from "@phone-mcp/shared";
import { loadConfig } from "./config.ts";
import { handleMcp } from "./mcp-http.ts";
import { DeviceRegistry, type WsData } from "./registry.ts";

const config = loadConfig();
const registry = new DeviceRegistry(config.commandTimeoutMs);

// Guard every agent/device entrypoint with a constant-time-ish token check.
function tokenFrom(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const q = url.searchParams.get("token");
  if (q) return q;
  // Accept a few common custom header names (MCP connectors often use x-token).
  const x = req.headers.get("x-phone-mcp-token") ?? req.headers.get("x-token") ?? req.headers.get("x-api-key");
  if (x) return x.trim();
  return null;
}

function authorized(req: Request, url: URL): boolean {
  const t = tokenFrom(req, url);
  if (!t) return false;
  // Length check first, then compare — avoids obvious length leak.
  return t.length === config.token.length && timingSafeEqual(t, config.token);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

// Unwrap a device ResultMsg into an HTTP shape the agent/MCP consumes.
function resultToResponse(r: ResultMsg): Response {
  if (!r.ok) return json({ ok: false, error: r.error ?? "command failed" }, 502);
  return json({ ok: true, data: r.data });
}

const server = Bun.serve<WsData>({
  port: config.port,
  idleTimeout: 120, // seconds; heartbeat keeps device sockets alive

  async fetch(req, srv) {
    const url = new URL(req.url);

    // ── Device WebSocket upgrade ────────────────────────────────────────────
    if (url.pathname === "/device") {
      if (!authorized(req, url)) return err("unauthorized", 401);
      const ok = srv.upgrade(req, { data: { kind: "device", deviceId: "" } });
      if (ok) return undefined as unknown as Response;
      return err("websocket upgrade failed", 426);
    }

    // ── Health (no auth) ─────────────────────────────────────────────────────
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "phone-mcp-server", devices: registry.list().length });
    }

    // ── MCP endpoint (Streamable HTTP, token-guarded) ───────────────────────────
    if (url.pathname === "/mcp") {
      if (!authorized(req, url)) return err("unauthorized", 401);
      return handleMcp(req, registry);
    }

    // ── Agent API (token-guarded) ──────────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req, url)) return err("unauthorized", 401);
      return handleApi(req, url);
    }

    return err("not found", 404);
  },

  websocket: {
    maxPayloadLength: 32 * 1024 * 1024, // 32MB — screenshots travel as base64 JSON
    idleTimeout: 120,

    message(ws: ServerWebSocket<WsData>, raw) {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      if (!isDeviceToServer(msg)) return;

      switch (msg.type) {
        case "register": {
          const info: DeviceInfo = {
            deviceId: msg.deviceId,
            model: msg.model,
            androidVersion: msg.androidVersion,
            screen: msg.screen,
            caps: msg.caps,
          };
          ws.data.deviceId = info.deviceId;
          registry.register(ws, info);
          ws.send(JSON.stringify({ type: "registered", ok: true }));
          console.log(`[device] registered: ${info.deviceId} (${info.model}, api ${info.androidVersion})`);
          break;
        }
        case "result": {
          if (ws.data.deviceId) registry.touch(ws.data.deviceId);
          registry.resolveResult(msg);
          break;
        }
        case "pong": {
          if (ws.data.deviceId) registry.touch(ws.data.deviceId);
          break;
        }
      }
    },

    close(ws) {
      if (ws.data.deviceId) {
        registry.remove(ws.data.deviceId, ws);
        console.log(`[device] disconnected: ${ws.data.deviceId}`);
      }
    },
  },
});

async function handleApi(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // GET /api/devices
  if (parts.length === 2 && parts[1] === "devices" && req.method === "GET") {
    return json({ ok: true, data: registry.list() });
  }

  // /api/devices/:id/...
  if (parts[1] === "devices" && parts[2]) {
    const deviceId = decodeURIComponent(parts[2]);

    // GET /api/devices/:id
    if (parts.length === 3 && req.method === "GET") {
      const status = registry.status(deviceId);
      if (!status) return err(`device offline: ${deviceId}`, 404);
      return json({ ok: true, data: status });
    }

    // POST /api/devices/:id/command   { cmd, args, timeoutMs? }
    if (parts.length === 4 && parts[3] === "command" && req.method === "POST") {
      if (!registry.has(deviceId)) return err(`device offline: ${deviceId}`, 404);
      let body: { cmd?: CommandName; args?: Record<string, unknown>; timeoutMs?: number };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return err("invalid JSON body");
      }
      if (!body.cmd) return err("missing 'cmd'");
      try {
        const r = await registry.sendCommand(
          deviceId,
          body.cmd,
          (body.args ?? {}) as CommandArgs<CommandName>,
          body.timeoutMs,
        );
        return resultToResponse(r);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 504);
      }
    }
  }

  return err("not found", 404);
}

// Heartbeat sweep.
setInterval(() => registry.sweep(config.heartbeatTimeoutMs), 15_000);

console.log(`[server] phone-mcp broker listening on :${server.port}`);
console.log(`[server] device WS endpoint:  ws://<host>:${server.port}/device?token=…`);
console.log(`[server] agent HTTP API:      http://<host>:${server.port}/api/…  (Bearer token)`);
console.log(`[server] MCP endpoint:        http://<host>:${server.port}/mcp     (x-token header)`);
if (config.publicUrl) console.log(`[server] public URL hint:     ${config.publicUrl}`);
