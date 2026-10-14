/**
 * Wire protocol shared by the server, the MCP, and (conceptually) the APK.
 *
 * Transport: WebSocket between device<->server. JSON for control messages,
 * binary is NOT used here — screenshots come back base64 inside a `result`
 * so the agent path stays dead simple (see ARCHITECTURE.md §6.1).
 */

// ─── Command catalog ──────────────────────────────────────────────────────────

export type CommandName =
  | "screenshot"
  | "ui_tree"
  | "tap"
  | "swipe"
  | "long_press"
  | "scroll"
  | "type_text"
  | "click_node"
  | "open_url"
  | "global_action"
  | "device_info";

export type GlobalAction = "back" | "home" | "recents" | "notifications";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface CommandArgsMap {
  screenshot: { format?: "jpeg" | "png"; quality?: number; maxWidth?: number };
  ui_tree: { maxDepth?: number; visibleOnly?: boolean };
  tap: { x: number; y: number };
  swipe: { x1: number; y1: number; x2: number; y2: number; durationMs?: number };
  long_press: { x: number; y: number; durationMs?: number };
  scroll: { direction: ScrollDirection; amount?: number };
  type_text: { text: string };
  click_node: { viewId?: string; text?: string; index?: number };
  open_url: { url: string; package?: string };
  global_action: { action: GlobalAction };
  device_info: Record<string, never>;
}

export type CommandArgs<C extends CommandName = CommandName> = CommandArgsMap[C];

// ─── UI tree ───────────────────────────────────────────────────────────────────

export interface Bounds {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface UiNode {
  class?: string;
  text?: string;
  desc?: string;
  viewId?: string;
  pkg?: string;
  bounds?: Bounds;
  clickable?: boolean;
  scrollable?: boolean;
  editable?: boolean;
  children?: UiNode[];
}

// ─── Device identity ────────────────────────────────────────────────────────────

export interface DeviceCaps {
  projection: boolean;
  accessibility: boolean;
}

export interface Screen {
  w: number;
  h: number;
}

export interface DeviceInfo {
  deviceId: string;
  model: string;
  androidVersion: number;
  screen: Screen;
  caps: DeviceCaps;
}

export interface DeviceStatus extends DeviceInfo {
  online: boolean;
  /** epoch ms of last message seen from the device */
  lastSeen: number;
  /** epoch ms the device registered this session */
  connectedAt: number;
}

// ─── Device → Server messages ────────────────────────────────────────────────────

export interface RegisterMsg extends DeviceInfo {
  type: "register";
}

export interface ResultMsg<T = unknown> {
  type: "result";
  reqId: string;
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PongMsg {
  type: "pong";
  ts: number;
}

export type DeviceToServer = RegisterMsg | ResultMsg | PongMsg;

// ─── Server → Device messages ─────────────────────────────────────────────────────

export interface CommandMsg<C extends CommandName = CommandName> {
  type: "command";
  reqId: string;
  cmd: C;
  args: CommandArgs<C>;
}

export interface PingMsg {
  type: "ping";
  ts: number;
}

export interface RegisteredMsg {
  type: "registered";
  ok: boolean;
  error?: string;
}

export type ServerToDevice = CommandMsg | PingMsg | RegisteredMsg;

// ─── Command result payloads (what `result.data` carries per command) ──────────────

export interface CommandResultMap {
  screenshot: { image: string; mime: string; w: number; h: number };
  ui_tree: { tree: UiNode };
  tap: { dispatched: boolean };
  swipe: { dispatched: boolean };
  long_press: { dispatched: boolean };
  scroll: { dispatched: boolean };
  type_text: { ok: boolean };
  click_node: { clicked: boolean };
  open_url: { launched: boolean };
  global_action: { ok: boolean };
  device_info: DeviceInfo;
}

export type CommandResult<C extends CommandName = CommandName> = CommandResultMap[C];

// ─── Helpers ───────────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1 as const;

export function isDeviceToServer(v: unknown): v is DeviceToServer {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}
