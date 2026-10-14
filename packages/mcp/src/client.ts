import type { CommandName, DeviceStatus } from "@phone-mcp/shared";

export interface ClientConfig {
  serverUrl: string;
  token: string;
}

export function loadClientConfig(): ClientConfig {
  const serverUrl = (process.env.PHONE_MCP_SERVER_URL || "http://localhost:8080").replace(/\/$/, "");
  const token = process.env.PHONE_MCP_TOKEN?.trim();
  if (!token) {
    console.error("[fatal] PHONE_MCP_TOKEN is not set for the MCP. Set it to the server's token.");
    process.exit(1);
  }
  return { serverUrl, token };
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/** Thin HTTP client over the broker's /api surface. */
export class BrokerClient {
  constructor(private readonly cfg: ClientConfig) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.serverUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      throw new ServerError(
        `cannot reach server at ${this.cfg.serverUrl} — is it running? (${e instanceof Error ? e.message : e})`,
        0,
      );
    }
    const text = await res.text();
    let body: { ok?: boolean; data?: unknown; error?: string } = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ServerError(`non-JSON response (${res.status}): ${text.slice(0, 200)}`, res.status);
      }
    }
    if (!res.ok || body.ok === false) {
      throw new ServerError(body.error ?? `request failed (${res.status})`, res.status);
    }
    return body.data as T;
  }

  listDevices(): Promise<DeviceStatus[]> {
    return this.request<DeviceStatus[]>("/api/devices");
  }

  deviceStatus(deviceId: string): Promise<DeviceStatus> {
    return this.request<DeviceStatus>(`/api/devices/${encodeURIComponent(deviceId)}`);
  }

  command<T = unknown>(
    deviceId: string,
    cmd: CommandName,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.request<T>(`/api/devices/${encodeURIComponent(deviceId)}/command`, {
      method: "POST",
      body: JSON.stringify({ cmd, args, timeoutMs }),
    });
  }
}
