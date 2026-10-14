import type { CommandName } from "@phone-mcp/shared";
import type { DeviceRegistry } from "./registry.ts";

/**
 * Minimal, stateless MCP server over Streamable HTTP (JSON-RPC 2.0 on POST).
 * Lets a hosted MCP client (e.g. Claude's custom connector) talk to the broker
 * directly at `/mcp` — no local stdio bridge needed. Commands run in-process
 * against the DeviceRegistry, so there is no extra HTTP hop.
 *
 * Stateless mode: we never issue an Mcp-Session-Id and we don't offer a
 * server-initiated SSE stream (GET → 405). Every request is self-contained.
 */

const SERVER_INFO = { name: "phone-mcp", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolOut {
  content: Content[];
  isError?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (reg: DeviceRegistry, args: Record<string, unknown>) => Promise<ToolOut>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function textOut(s: string): ToolOut {
  return { content: [{ type: "text", text: s }] };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function resolveDevice(reg: DeviceRegistry, deviceId?: unknown): Promise<string> {
  if (typeof deviceId === "string" && deviceId.length > 0) return deviceId;
  const devices = reg.list();
  if (devices.length === 1) return devices[0]!.deviceId;
  if (devices.length === 0) throw new Error("no devices online (open the app on a phone first)");
  throw new Error(
    `multiple devices online (${devices.map((d) => d.deviceId).join(", ")}); pass deviceId`,
  );
}

// Loosely-typed command helper: the broker validates args device-side.
async function runCmd(
  reg: DeviceRegistry,
  id: string,
  cmd: CommandName,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (reg.sendCommand as any)(id, cmd, args, timeoutMs);
  if (!r.ok) throw new Error(r.error ?? "command failed");
  return r.data;
}

const DEVICE_ID_PROP = {
  deviceId: {
    type: "string",
    description: "Target device id. Optional when exactly one device is online.",
  },
};

function schema(
  props: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...DEVICE_ID_PROP, ...props },
    required,
    additionalProperties: false,
  };
}

// ── tool catalog (mirrors the stdio bridge) ───────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "list_devices",
    description: "List all Android devices currently connected to the broker, with their status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (reg) => {
      const devices = reg.list();
      if (devices.length === 0) return textOut("No devices online. Open the app on a phone and point it at this server.");
      const lines = devices.map((d) => {
        const ago = Math.round((Date.now() - d.lastSeen) / 1000);
        return (
          `• ${d.deviceId} — ${d.model} (Android API ${d.androidVersion}), ` +
          `${d.screen.w}×${d.screen.h}, caps: ${d.caps.projection ? "screen" : "no-screen"}/` +
          `${d.caps.accessibility ? "a11y" : "no-a11y"}, last seen ${ago}s ago`
        );
      });
      return textOut(`${devices.length} device(s) online:\n${lines.join("\n")}`);
    },
  },
  {
    name: "get_device_status",
    description: "Get detailed status for one device (model, screen size, capabilities, last seen).",
    inputSchema: schema({}),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      const status = reg.status(id);
      if (!status) throw new Error(`device offline: ${id}`);
      return textOut(JSON.stringify(status, null, 2));
    },
  },
  {
    name: "device_info",
    description: "Ask the device directly for its hardware/OS info.",
    inputSchema: schema({}),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      return textOut(JSON.stringify(await runCmd(reg, id, "device_info"), null, 2));
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the device screen and return it as an image. Use this to 'see' what is on screen " +
      "(media content like video feeds is NOT in the UI tree — rely on screenshots for content).",
    inputSchema: schema({
      maxWidth: { type: "number", description: "Downscale to this width (px). Default 720." },
      quality: { type: "number", description: "JPEG quality 1-100. Default 80." },
    }),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      const data = (await runCmd(
        reg,
        id,
        "screenshot",
        { maxWidth: (a.maxWidth as number) ?? 720, quality: (a.quality as number) ?? 80, format: "jpeg" },
        20_000,
      )) as { image: string; mime: string; w: number; h: number };
      return {
        content: [
          { type: "text", text: `Screenshot of ${id} (${data.w}×${data.h})` },
          { type: "image", data: data.image, mimeType: data.mime },
        ],
      };
    },
  },
  {
    name: "open_url",
    description:
      "Launch a URL or deep link via Android Intent. Preferred over tapping for opening links/profiles — far more reliable.",
    inputSchema: schema(
      {
        url: { type: "string", description: "URL or deep link to open." },
        package: { type: "string", description: "Force a target app package, e.g. com.zhiliaoapp.musically." },
      },
      ["url"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "open_url", { url: a.url, package: a.package });
      return textOut(`Launched: ${a.url}${a.package ? ` (package ${a.package})` : ""}`);
    },
  },
  {
    name: "ui_tree",
    description:
      "Read the accessibility UI tree (nodes with text, ids, bounds, clickable flags). Good for navigation; NOT for reading media content.",
    inputSchema: schema({
      maxDepth: { type: "number", description: "Max tree depth. Default 40." },
      visibleOnly: { type: "boolean", description: "Only include on-screen nodes. Default true." },
    }),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      const data = (await runCmd(reg, id, "ui_tree", {
        maxDepth: (a.maxDepth as number) ?? 40,
        visibleOnly: (a.visibleOnly as boolean) ?? true,
      })) as { tree: unknown };
      return textOut(JSON.stringify(data.tree, null, 2));
    },
  },
  {
    name: "tap",
    description: "Tap at screen coordinates (px).",
    inputSchema: schema({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "tap", { x: a.x, y: a.y });
      return textOut(`Tapped (${a.x}, ${a.y}) on ${id}`);
    },
  },
  {
    name: "swipe",
    description: "Swipe from (x1,y1) to (x2,y2) over an optional duration.",
    inputSchema: schema(
      {
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        durationMs: { type: "number", description: "Default 300ms." },
      },
      ["x1", "y1", "x2", "y2"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "swipe", { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, durationMs: (a.durationMs as number) ?? 300 });
      return textOut(`Swiped (${a.x1},${a.y1})→(${a.x2},${a.y2}) on ${id}`);
    },
  },
  {
    name: "long_press",
    description: "Long-press at coordinates.",
    inputSchema: schema(
      { x: { type: "number" }, y: { type: "number" }, durationMs: { type: "number", description: "Default 600ms." } },
      ["x", "y"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "long_press", { x: a.x, y: a.y, durationMs: (a.durationMs as number) ?? 600 });
      return textOut(`Long-pressed (${a.x}, ${a.y}) on ${id}`);
    },
  },
  {
    name: "scroll",
    description: "Scroll the screen in a direction (e.g. 'down' to advance a feed).",
    inputSchema: schema(
      {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Number of scroll steps. Default 1." },
      },
      ["direction"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "scroll", { direction: a.direction, amount: (a.amount as number) ?? 1 });
      return textOut(`Scrolled ${a.direction} on ${id}`);
    },
  },
  {
    name: "type_text",
    description: "Type text into the currently focused input field.",
    inputSchema: schema({ text: { type: "string" } }, ["text"]),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "type_text", { text: a.text });
      return textOut(`Typed ${String(a.text).length} char(s) on ${id}`);
    },
  },
  {
    name: "click_node",
    description:
      "Click a UI node precisely by its viewId and/or text (more reliable than tapping coordinates). Find candidates with ui_tree first.",
    inputSchema: schema({
      viewId: { type: "string", description: "viewIdResourceName, e.g. com.app:id/follow" },
      text: { type: "string", description: "Visible text or contentDescription to match." },
      index: { type: "number", description: "Which match to click if several. Default 0." },
    }),
    run: async (reg, a) => {
      if (!a.viewId && !a.text) throw new Error("provide viewId and/or text");
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "click_node", { viewId: a.viewId, text: a.text, index: (a.index as number) ?? 0 });
      return textOut(`Clicked node ${a.viewId ?? ""}${a.text ? ` "${a.text}"` : ""} on ${id}`);
    },
  },
  {
    name: "global_action",
    description: "Perform a system navigation action: back, home, recents, or notifications.",
    inputSchema: schema(
      { action: { type: "string", enum: ["back", "home", "recents", "notifications"] } },
      ["action"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "global_action", { action: a.action });
      return textOut(`Performed '${a.action}' on ${id}`);
    },
  },
];

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────────

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleRpc(reg: DeviceRegistry, m: Record<string, unknown>): Promise<object | null> {
  const id = m.id;
  const method = m.method as string | undefined;
  const params = (m.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get acknowledged with no body.
  if (!method) return rpcError(id ?? null, -32600, "Invalid Request: missing method");
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params.protocolVersion as string) ?? DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${String(params.name)}`);
      try {
        const out = await tool.run(reg, (params.arguments ?? {}) as Record<string, unknown>);
        return rpcResult(id, out);
      } catch (e) {
        // Tool-level failures are returned as a result with isError (MCP convention),
        // so the model sees the message instead of a transport error.
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${msgOf(e)}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Entry point wired into the broker's fetch handler for `/mcp`. */
export async function handleMcp(req: Request, reg: DeviceRegistry): Promise<Response> {
  if (req.method === "GET") {
    // No server-initiated stream in stateless mode.
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(reg, m as Record<string, unknown>)))).filter(
      (r): r is object => r !== null,
    );
    if (out.length === 0) return new Response(null, { status: 202 });
    return jsonResponse(out);
  }

  const resp = await handleRpc(reg, (body ?? {}) as Record<string, unknown>);
  if (resp === null) return new Response(null, { status: 202 });
  return jsonResponse(resp);
}
