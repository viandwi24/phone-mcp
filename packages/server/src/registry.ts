import type { ServerWebSocket } from "bun";
import type {
  CommandArgs,
  CommandName,
  DeviceInfo,
  DeviceStatus,
  ResultMsg,
} from "@phone-mcp/shared";

export interface WsData {
  kind: "device";
  deviceId: string;
}

interface DeviceEntry {
  ws: ServerWebSocket<WsData>;
  info: DeviceInfo;
  connectedAt: number;
  lastSeen: number;
}

interface Pending {
  resolve: (r: ResultMsg) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * In-memory registry of connected devices + correlation table for in-flight
 * commands. There is intentionally no persistence: a restart drops all state
 * and devices reconnect + re-register.
 */
export class DeviceRegistry {
  private devices = new Map<string, DeviceEntry>();
  private pending = new Map<string, Pending>();

  constructor(private readonly commandTimeoutMs: number) {}

  register(ws: ServerWebSocket<WsData>, info: DeviceInfo): void {
    // If a device with the same id is already connected, replace it.
    const existing = this.devices.get(info.deviceId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, "replaced by new connection");
      } catch {
        /* ignore */
      }
    }
    const now = Date.now();
    this.devices.set(info.deviceId, { ws, info, connectedAt: now, lastSeen: now });
  }

  touch(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d) d.lastSeen = Date.now();
  }

  /** Remove a device, but only if the socket matches (avoid races on replace). */
  remove(deviceId: string, ws: ServerWebSocket<WsData>): void {
    const d = this.devices.get(deviceId);
    if (d && d.ws === ws) this.devices.delete(deviceId);
  }

  has(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  list(): DeviceStatus[] {
    return [...this.devices.values()].map((d) => this.toStatus(d));
  }

  status(deviceId: string): DeviceStatus | undefined {
    const d = this.devices.get(deviceId);
    return d ? this.toStatus(d) : undefined;
  }

  private toStatus(d: DeviceEntry): DeviceStatus {
    return {
      ...d.info,
      online: true,
      connectedAt: d.connectedAt,
      lastSeen: d.lastSeen,
    };
  }

  /** Resolve a pending command when its result arrives. */
  resolveResult(msg: ResultMsg): void {
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.reqId);
    p.resolve(msg);
  }

  /** Send a command to a device and await its result (or timeout). */
  sendCommand<C extends CommandName>(
    deviceId: string,
    cmd: C,
    args: CommandArgs<C>,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<ResultMsg> {
    const d = this.devices.get(deviceId);
    if (!d) return Promise.reject(new Error(`device offline: ${deviceId}`));

    const reqId = crypto.randomUUID();
    return new Promise<ResultMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`command timed out after ${timeoutMs}ms: ${cmd}`));
      }, timeoutMs);

      this.pending.set(reqId, { resolve, reject, timer });

      try {
        d.ws.send(JSON.stringify({ type: "command", reqId, cmd, args }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Drop stale devices + ping everyone. Called on an interval. */
  sweep(heartbeatTimeoutMs: number): void {
    const now = Date.now();
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > heartbeatTimeoutMs) {
        try {
          d.ws.close(4001, "heartbeat timeout");
        } catch {
          /* ignore */
        }
        this.devices.delete(id);
        continue;
      }
      try {
        d.ws.send(JSON.stringify({ type: "ping", ts: now }));
      } catch {
        /* ignore */
      }
    }
  }
}
