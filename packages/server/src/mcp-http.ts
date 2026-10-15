import {
  buildSnapshot,
  describeScreen,
  resolveRef,
  type CommandName,
  type RefEntry,
  type UiNode,
} from "@phone-mcp/shared";
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


// ── snapshot / ref state (per device, in memory) ────────────────────────────────

const lastRefs = new Map<string, RefEntry[]>();
const lastFingerprint = new Map<string, string>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchTree(reg: DeviceRegistry, id: string, maxDepth = 40): Promise<UiNode> {
  const data = (await runCmd(reg, id, "ui_tree", { maxDepth, visibleOnly: true })) as { tree: UiNode };
  return data.tree;
}

/**
 * One-line "where am I now" hint appended to action results (default on; pass
 * hint:false to skip). Never throws: the action already succeeded.
 */
async function hintLine(reg: DeviceRegistry, id: string, a: Record<string, unknown>, settleMs = 400): Promise<string> {
  if (a.hint === false) return "";
  try {
    await sleep(settleMs);
    const d = describeScreen(await fetchTree(reg, id, 40));
    const prev = lastFingerprint.get(id);
    lastFingerprint.set(id, d.fingerprint);
    const changed = prev === undefined ? "" : prev === d.fingerprint ? " (screen unchanged)" : " (screen changed)";
    return `\nnow: ${d.pkg ?? "unknown app"} — "${d.title ?? "untitled"}"${changed}`;
  } catch {
    return "";
  }
}

async function acted(reg: DeviceRegistry, id: string, a: Record<string, unknown>, line: string, settleMs?: number): Promise<ToolOut> {
  return textOut(line + (await hintLine(reg, id, a, settleMs)));
}

/** Resolve a snapshot ref against a fresh tree; throws a readable error when stale. */
async function refPoint(reg: DeviceRegistry, id: string, ref: string): Promise<{ x: number; y: number; label: string }> {
  const r = resolveRef(lastRefs.get(id), ref, await fetchTree(reg, id));
  if (!r.ok) throw new Error(r.error);
  return { x: r.x, y: r.y, label: r.entry.label };
}

const HINT_PROP = {
  hint: {
    type: "boolean",
    description: "Append a one-line 'now: app — screen title' hint to the result. Default true; false to skip (faster).",
  },
};
const REF_PROP = {
  ref: { type: "string", description: "Ref like n12 from the latest `snapshot`." },
};

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── tool catalog ───────────────────────────────────

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
    name: "snapshot",
    description:
      "PREFERRED way to see the screen. Returns a compact text snapshot of the UI: one line per meaningful " +
      "element with a short ref like [n12], role, label and flags (clickable, focused, checked, scrollable, " +
      "editable). Act on elements with `tap`/`type_text`/`click_node` using `ref`. Small (<~12 KB, 300 lines max); " +
      "if truncated, narrow with `within: <ref>` (e.g. a list) or scroll. Does NOT show images/video — use " +
      "`screenshot` for that. Take one when you need to find something to act on, not after every step " +
      "(action results already say which app/screen you are on).",
    inputSchema: schema({
      within: { type: "string", description: "Ref from the previous snapshot: render only that element's subtree." },
      maxLines: { type: "number", description: "Line cap. Default 300, max 600." },
      maxChars: { type: "number", description: "Character cap. Default 12000, max 24000." },
    }),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      const tree = await fetchTree(reg, id);
      const r = buildSnapshot(tree, {
        within: typeof a.within === "string" ? a.within : undefined,
        previous: lastRefs.get(id),
        maxLines: isNum(a.maxLines) ? Math.min(600, Math.max(1, a.maxLines)) : undefined,
        maxChars: isNum(a.maxChars) ? Math.min(24_000, Math.max(500, a.maxChars)) : undefined,
      });
      if (!r.ok) throw new Error(r.error);
      if (a.within) {
        const merged = new Map((lastRefs.get(id) ?? []).map((e) => [e.ref, e]));
        for (const e of r.refs) merged.set(e.ref, e);
        lastRefs.set(id, [...merged.values()]);
      } else {
        lastRefs.set(id, r.refs);
      }
      lastFingerprint.set(id, r.fingerprint);
      return textOut(r.text);
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the screen as an image. Use ONLY when you need to see visual content the snapshot cannot show " +
      "(videos, photos, canvas/feed apps like TikTok or YouTube, captchas, layout). For finding buttons and " +
      "text prefer `snapshot`. Defaults are small (540px wide, JPEG q60, typically <60 KB); raise maxWidth/quality " +
      "only if you must read fine detail.",
    inputSchema: schema({
      maxWidth: { type: "number", description: "Downscale to this width (px). Default 540." },
      quality: { type: "number", description: "JPEG quality 1-100. Default 60." },
    }),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      const data = (await runCmd(
        reg,
        id,
        "screenshot",
        { maxWidth: isNum(a.maxWidth) ? a.maxWidth : 540, quality: isNum(a.quality) ? a.quality : 60, format: "jpeg" },
        20_000,
      )) as { image: string; mime: string; w: number; h: number };
      const bytes = Math.round((data.image.length * 3) / 4);
      return {
        content: [
          { type: "text", text: `Screenshot of ${id}: ${data.w}×${data.h}, ${data.mime}, ${(bytes / 1024).toFixed(0)} KB` },
          { type: "image", data: data.image, mimeType: data.mime },
        ],
      };
    },
  },
  {
    name: "open_url",
    description:
      "Launch a URL or deep link via Android Intent. Preferred over tapping for opening links/profiles — far more reliable. " +
      "The result says which app/screen is now showing; take a `snapshot` or `screenshot` only if you need more.",
    inputSchema: schema(
      {
        url: { type: "string", description: "URL or deep link to open." },
        package: { type: "string", description: "Force a target app package, e.g. com.zhiliaoapp.musically." },
        ...HINT_PROP,
      },
      ["url"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "open_url", { url: a.url, package: a.package });
      return acted(reg, id, a, `Launched: ${a.url}${a.package ? ` (package ${a.package})` : ""}`, 1500);
    },
  },
  {
    name: "ui_tree",
    description:
      "Raw accessibility tree as JSON (all nodes, bounds, ids). LARGE (often 10-30 KB) — prefer `snapshot`, which " +
      "is compact and gives refs. Use only when you need exact bounds/viewIds the snapshot omits.",
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
      return textOut(JSON.stringify(data.tree));
    },
  },
  {
    name: "tap",
    description:
      "Tap an element by `ref` from the latest `snapshot` (preferred), or at screen coordinates x,y (px). " +
      "A ref that no longer matches the screen returns a 'stale ref' error: take a new snapshot.",
    inputSchema: schema({ ...REF_PROP, x: { type: "number" }, y: { type: "number" }, ...HINT_PROP }),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      if (typeof a.ref === "string") {
        const p = await refPoint(reg, id, a.ref);
        await runCmd(reg, id, "tap", { x: p.x, y: p.y });
        return acted(reg, id, a, `Tapped ${a.ref}${p.label ? ` "${p.label}"` : ""} at (${p.x}, ${p.y})`);
      }
      if (!isNum(a.x) || !isNum(a.y)) throw new Error("provide `ref` (from snapshot) or both x and y");
      await runCmd(reg, id, "tap", { x: a.x, y: a.y });
      return acted(reg, id, a, `Tapped (${a.x}, ${a.y})`);
    },
  },
  {
    name: "swipe",
    description: "Swipe from (x1,y1) to (x2,y2) over an optional duration. For lists prefer `scroll`.",
    inputSchema: schema(
      {
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        durationMs: { type: "number", description: "Default 300ms." },
        ...HINT_PROP,
      },
      ["x1", "y1", "x2", "y2"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "swipe", { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, durationMs: (a.durationMs as number) ?? 300 });
      return acted(reg, id, a, `Swiped (${a.x1},${a.y1})→(${a.x2},${a.y2})`);
    },
  },
  {
    name: "long_press",
    description: "Long-press an element by `ref` from the latest `snapshot`, or at coordinates.",
    inputSchema: schema(
      { ...REF_PROP, x: { type: "number" }, y: { type: "number" }, durationMs: { type: "number", description: "Default 600ms." }, ...HINT_PROP },
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      let x = a.x;
      let y = a.y;
      if (typeof a.ref === "string") {
        const p = await refPoint(reg, id, a.ref);
        x = p.x;
        y = p.y;
      }
      if (!isNum(x) || !isNum(y)) throw new Error("provide `ref` (from snapshot) or both x and y");
      await runCmd(reg, id, "long_press", { x, y, durationMs: (a.durationMs as number) ?? 600 });
      return acted(reg, id, a, `Long-pressed (${x}, ${y})`);
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the screen in a direction (e.g. 'down' to advance a feed). The result tells you whether the screen " +
      "changed; take a `snapshot` after if you need the new contents.",
    inputSchema: schema(
      {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Number of scroll steps. Default 1." },
        ...HINT_PROP,
      },
      ["direction"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "scroll", { direction: a.direction, amount: (a.amount as number) ?? 1 });
      return acted(reg, id, a, `Scrolled ${a.direction}`);
    },
  },
  {
    name: "type_text",
    description:
      "Type text into an input field. Pass `ref` (an editable element from the latest `snapshot`) to focus it first; " +
      "without `ref` it types into the currently focused field.",
    inputSchema: schema({ text: { type: "string" }, ...REF_PROP, ...HINT_PROP }, ["text"]),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      if (typeof a.ref === "string") {
        const p = await refPoint(reg, id, a.ref);
        await runCmd(reg, id, "tap", { x: p.x, y: p.y });
        await sleep(300);
      }
      await runCmd(reg, id, "type_text", { text: a.text });
      return acted(reg, id, a, `Typed ${String(a.text).length} char(s)${a.ref ? ` into ${a.ref}` : ""}`);
    },
  },
  {
    name: "click_node",
    description:
      "Click an element by `ref` from the latest `snapshot` (preferred), or by viewId and/or text (accessibility " +
      "match, more reliable than coordinates when no snapshot is at hand).",
    inputSchema: schema({
      ...REF_PROP,
      viewId: { type: "string", description: "viewIdResourceName, e.g. com.app:id/follow" },
      text: { type: "string", description: "Visible text or contentDescription to match." },
      index: { type: "number", description: "Which match to click if several. Default 0." },
      ...HINT_PROP,
    }),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      if (typeof a.ref === "string") {
        const p = await refPoint(reg, id, a.ref);
        await runCmd(reg, id, "tap", { x: p.x, y: p.y });
        return acted(reg, id, a, `Clicked ${a.ref}${p.label ? ` "${p.label}"` : ""}`);
      }
      if (!a.viewId && !a.text) throw new Error("provide ref, or viewId and/or text");
      await runCmd(reg, id, "click_node", { viewId: a.viewId, text: a.text, index: (a.index as number) ?? 0 });
      return acted(reg, id, a, `Clicked node ${a.viewId ?? ""}${a.text ? ` "${a.text}"` : ""}`);
    },
  },
  {
    name: "global_action",
    description: "Perform a system navigation action: back, home, recents, or notifications.",
    inputSchema: schema(
      { action: { type: "string", enum: ["back", "home", "recents", "notifications"] }, ...HINT_PROP },
      ["action"],
    ),
    run: async (reg, a) => {
      const id = await resolveDevice(reg, a.deviceId);
      await runCmd(reg, id, "global_action", { action: a.action });
      return acted(reg, id, a, `Performed '${a.action}'`);
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
