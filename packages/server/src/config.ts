export interface Config {
  port: number;
  token: string;
  commandTimeoutMs: number;
  heartbeatTimeoutMs: number;
  publicUrl: string | undefined;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const token = process.env.PHONE_MCP_TOKEN?.trim();
  if (!token) {
    console.error(
      "[fatal] PHONE_MCP_TOKEN is not set. Generate one with `openssl rand -hex 32` " +
        "and export it (or put it in .env).",
    );
    process.exit(1);
  }
  if (token.length < 16) {
    console.warn("[warn] PHONE_MCP_TOKEN is short (<16 chars). Use a long random value.");
  }

  return {
    port: num("PORT", 8080),
    token,
    commandTimeoutMs: num("COMMAND_TIMEOUT_MS", 15_000),
    heartbeatTimeoutMs: num("HEARTBEAT_TIMEOUT_MS", 45_000),
    publicUrl: process.env.PUBLIC_URL?.trim() || undefined,
  };
}
