#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CommandResult, DeviceStatus, UiNode } from "@phone-mcp/shared";
import { BrokerClient, loadClientConfig, ServerError } from "./client.ts";

const client = new BrokerClient(loadClientConfig());

const server = new McpServer({
  name: "phone-mcp",
  version: "0.1.0",
});

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof ServerError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

/**
 * Resolve which device a command targets. If `deviceId` is given, use it.
 * Otherwise, if exactly one device is online, use it. Else error with a hint.
 */
async function resolveDevice(deviceId?: string): Promise<string> {
  if (deviceId) return deviceId;
  const devices = await client.listDevices();
  if (devices.length === 1) return devices[0]!.deviceId;
  if (devices.length === 0) throw new ServerError("no devices online", 404);
  throw new ServerError(
    `multiple devices online (${devices.map((d) => d.deviceId).join(", ")}); pass deviceId`,
    400,
  );
}

const deviceIdArg = {
  deviceId: z
    .string()
    .optional()
    .describe("Target device id. Optional when exactly one device is online."),
};

function summarizeDevice(d: DeviceStatus): string {
  const ago = Math.round((Date.now() - d.lastSeen) / 1000);
  return (
    `• ${d.deviceId} — ${d.model} (Android API ${d.androidVersion}), ` +
    `${d.screen.w}×${d.screen.h}, caps: ${d.caps.projection ? "screen" : "no-screen"}/` +
    `${d.caps.accessibility ? "a11y" : "no-a11y"}, last seen ${ago}s ago`
  );
}

// ─── Status / discovery tools ───────────────────────────────────────────────────

server.registerTool(
  "list_devices",
  {
    title: "List devices",
    description: "List all Android devices currently connected to the broker, with their status.",
    inputSchema: {},
  },
  async () => {
    try {
      const devices = await client.listDevices();
      if (devices.length === 0) return text("No devices online. Open the APK on a phone and point it at this server.");
      return text(`${devices.length} device(s) online:\n${devices.map(summarizeDevice).join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_device_status",
  {
    title: "Get device status",
    description: "Get detailed status for one device (model, screen size, capabilities, last seen).",
    inputSchema: { ...deviceIdArg },
  },
  async ({ deviceId }) => {
    try {
      const id = await resolveDevice(deviceId);
      const status = await client.deviceStatus(id);
      return text(JSON.stringify(status, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "device_info",
  {
    title: "Device info",
    description: "Ask the device directly for its hardware/OS info.",
    inputSchema: { ...deviceIdArg },
  },
  async ({ deviceId }) => {
    try {
      const id = await resolveDevice(deviceId);
      const data = await client.command<CommandResult<"device_info">>(id, "device_info");
      return text(JSON.stringify(data, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── Vision ──────────────────────────────────────────────────────────────────────

server.registerTool(
  "screenshot",
  {
    title: "Screenshot",
    description:
      "Capture the screen as an image. Use it for visual content the UI tree cannot show (video/feed apps " +
      "like TikTok/YouTube, photos, canvas). Defaults are small (540px, JPEG q60); don't call it after every step.",
    inputSchema: {
      ...deviceIdArg,
      maxWidth: z.number().int().positive().max(2000).optional().describe("Downscale to this width (px). Default 540."),
      quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100. Default 60."),
    },
  },
  async ({ deviceId, maxWidth, quality }) => {
    try {
      const id = await resolveDevice(deviceId);
      const data = await client.command<CommandResult<"screenshot">>(
        id,
        "screenshot",
        { maxWidth: maxWidth ?? 540, quality: quality ?? 60, format: "jpeg" },
        20_000,
      );
      return {
        content: [
          {
            type: "text",
            text: `Screenshot of ${id}: ${data.w}×${data.h}, ${data.mime}, ${Math.round((data.image.length * 3) / 4 / 1024)} KB`,
          },
          { type: "image", data: data.image, mimeType: data.mime },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── Navigation (intent-first) ──────────────────────────────────────────────────────

server.registerTool(
  "open_url",
  {
    title: "Open URL / deep link",
    description:
      "Launch a URL or deep link via Android Intent (startActivity). Preferred over tapping for " +
      "opening links/profiles — far more reliable. e.g. a TikTok profile or a vt.tiktok.com share link.",
    inputSchema: {
      ...deviceIdArg,
      url: z.string().describe("URL or deep link to open."),
      package: z
        .string()
        .optional()
        .describe("Force a target app package, e.g. com.zhiliaoapp.musically (TikTok global)."),
    },
  },
  async ({ deviceId, url, package: pkg }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command<CommandResult<"open_url">>(id, "open_url", { url, package: pkg });
      return text(`Launched: ${url}${pkg ? ` (package ${pkg})` : ""}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── UI tree ──────────────────────────────────────────────────────────────────────

function countNodes(n: UiNode): number {
  return 1 + (n.children?.reduce((a, c) => a + countNodes(c), 0) ?? 0);
}

server.registerTool(
  "ui_tree",
  {
    title: "Read UI tree",
    description:
      "Read the accessibility UI tree (nodes with text, ids, bounds, clickable flags). Good for " +
      "navigation and finding buttons; NOT for reading media content like video feeds.",
    inputSchema: {
      ...deviceIdArg,
      maxDepth: z.number().int().positive().max(100).optional().describe("Max tree depth. Default 40."),
      visibleOnly: z.boolean().optional().describe("Only include on-screen nodes. Default true."),
    },
  },
  async ({ deviceId, maxDepth, visibleOnly }) => {
    try {
      const id = await resolveDevice(deviceId);
      const data = await client.command<CommandResult<"ui_tree">>(id, "ui_tree", {
        maxDepth: maxDepth ?? 40,
        visibleOnly: visibleOnly ?? true,
      });
      return text(`UI tree (${countNodes(data.tree)} nodes):\n${JSON.stringify(data.tree)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── Gestures ────────────────────────────────────────────────────────────────────────

server.registerTool(
  "tap",
  {
    title: "Tap",
    description: "Tap at screen coordinates (px).",
    inputSchema: { ...deviceIdArg, x: z.number(), y: z.number() },
  },
  async ({ deviceId, x, y }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command(id, "tap", { x, y });
      return text(`Tapped (${x}, ${y}) on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "swipe",
  {
    title: "Swipe",
    description: "Swipe from (x1,y1) to (x2,y2) over an optional duration.",
    inputSchema: {
      ...deviceIdArg,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      durationMs: z.number().int().positive().optional().describe("Default 300ms."),
    },
  },
  async ({ deviceId, x1, y1, x2, y2, durationMs }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command(id, "swipe", { x1, y1, x2, y2, durationMs: durationMs ?? 300 });
      return text(`Swiped (${x1},${y1})→(${x2},${y2}) on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "long_press",
  {
    title: "Long press",
    description: "Long-press at coordinates.",
    inputSchema: {
      ...deviceIdArg,
      x: z.number(),
      y: z.number(),
      durationMs: z.number().int().positive().optional().describe("Default 600ms."),
    },
  },
  async ({ deviceId, x, y, durationMs }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command(id, "long_press", { x, y, durationMs: durationMs ?? 600 });
      return text(`Long-pressed (${x}, ${y}) on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "scroll",
  {
    title: "Scroll",
    description: "Scroll the screen in a direction (e.g. 'down' to advance a feed).",
    inputSchema: {
      ...deviceIdArg,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().positive().optional().describe("Number of scroll steps. Default 1."),
    },
  },
  async ({ deviceId, direction, amount }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command(id, "scroll", { direction, amount: amount ?? 1 });
      return text(`Scrolled ${direction} on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "type_text",
  {
    title: "Type text",
    description: "Type text into the currently focused input field.",
    inputSchema: { ...deviceIdArg, text: z.string() },
  },
  async ({ deviceId, text: t }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command(id, "type_text", { text: t });
      return text(`Typed ${t.length} char(s) on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "click_node",
  {
    title: "Click node",
    description:
      "Click a UI node precisely by its viewId and/or text (more reliable than tapping coordinates). " +
      "Find candidates with ui_tree first.",
    inputSchema: {
      ...deviceIdArg,
      viewId: z.string().optional().describe("viewIdResourceName, e.g. com.app:id/follow"),
      text: z.string().optional().describe("Visible text or contentDescription to match."),
      index: z.number().int().min(0).optional().describe("Which match to click if several. Default 0."),
    },
  },
  async ({ deviceId, viewId, text: t, index }) => {
    try {
      if (!viewId && !t) throw new ServerError("provide viewId and/or text", 400);
      const id = await resolveDevice(deviceId);
      await client.command(id, "click_node", { viewId, text: t, index: index ?? 0 });
      return text(`Clicked node ${viewId ?? ""}${t ? ` "${t}"` : ""} on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "global_action",
  {
    title: "Global action",
    description: "Perform a system navigation action: back, home, recents, or notifications.",
    inputSchema: { ...deviceIdArg, action: z.enum(["back", "home", "recents", "notifications"]) },
  },
  async ({ deviceId, action }) => {
    try {
      const id = await resolveDevice(deviceId);
      await client.command(id, "global_action", { action });
      return text(`Performed '${action}' on ${id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wake_screen",
  {
    title: "Wake screen",
    description:
      "Turn the screen on and dismiss a swipe/none lock. Rarely needed: every screen tool wakes the phone " +
      "automatically and it re-locks when idle. A PIN/pattern/biometric lock cannot be unlocked remotely.",
    inputSchema: {
      ...deviceIdArg,
      idleLockSec: z.number().int().min(0).optional().describe("Auto-lock after N idle seconds. Default 30; 0 = never."),
    },
  },
  async ({ deviceId, idleLockSec }) => {
    try {
      const id = await resolveDevice(deviceId);
      const d = await client.command<CommandResult<"wake">>(id, "wake", idleLockSec === undefined ? {} : { idleLockSec });
      const lock = d.idleLockSec > 0 ? `auto-locks after ${d.idleLockSec}s idle` : "auto-lock disabled";
      return text(`Screen ${d.woke ? "woken" : "already on"}, ${d.locked ? "still locked" : "unlocked"}; ${lock}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "lock_screen",
  {
    title: "Lock screen",
    description: "Turn the screen off now. Call when a task is done to save battery; otherwise it auto-locks when idle.",
    inputSchema: { ...deviceIdArg },
  },
  async ({ deviceId }) => {
    try {
      const id = await resolveDevice(deviceId);
      const d = await client.command<CommandResult<"lock">>(id, "lock");
      return text(d.ok ? "Screen locked." : "Could not lock (needs Accessibility on Android 9+); it will time out normally.");
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── Boot ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  console.error("[phone-mcp] MCP server ready on stdio");
}

main().catch((e) => {
  console.error("[phone-mcp] fatal:", e);
  process.exit(1);
});
