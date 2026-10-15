# phone-mcp

Remote-control an Android phone from an AI agent — **no ADB, no root, no emulator**.
Install one APK on a real phone, point it at your server, and an MCP client (Claude,
etc.) can list devices, take screenshots, open links/deep-links, read the UI tree,
and drive taps/swipes/typing.

```
┌──────────────┐   MCP (stdio)   ┌─────────────────────┐   WebSocket    ┌──────────────────┐
│  AI agent    │ ◄─────────────► │  broker server      │ ◄────────────► │  Android phone   │
│  (MCP client)│                 │  (Bun + WebSocket)  │   cmd + result │  (this APK)      │
└──────────────┘                 └─────────────────────┘                └──────────────────┘
```

A single **token** (from an env var) guards both sides: the MCP authenticates to the
server with it, and the phone connects to the server with it. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

## Monorepo layout

```
packages/
  shared/   # wire protocol + shared TypeScript types
  server/   # Bun broker: device WebSocket + token-guarded agent HTTP API
  mcp/       # MCP server (stdio) that drives the broker on behalf of an agent
android/     # the Kotlin APK (foreground service, accessibility, media projection)
Dockerfile   # hosts the broker server
.github/     # CI (typecheck + smoke APK) and Release (semver -> APK + GHCR)
```

Runtime & package manager: **[Bun](https://bun.sh)**. TypeScript throughout.

---

## 1. Run the server

The server is the broker both the phone and the MCP talk to. Host it anywhere the
phone can reach over the internet (a VPS, a tunnel, etc.).

```bash
cp .env.example .env
# edit .env — at minimum set a long random PHONE_MCP_TOKEN:
#   openssl rand -hex 32

bun install
PHONE_MCP_TOKEN=$(grep PHONE_MCP_TOKEN .env | cut -d= -f2) bun run server
```

Or with Docker:

```bash
docker compose up -d        # reads PHONE_MCP_TOKEN from .env
# or
docker build -t phone-mcp-server .
docker run -p 8080:8080 -e PHONE_MCP_TOKEN=... phone-mcp-server
```

Health check: `curl http://localhost:8080/health`.

> Put the server behind HTTPS (a reverse proxy / tunnel) so the phone can use
> `wss://` and the token isn't sent in clear text.

---

## 2. Install the APK on a phone

1. Grab `phone-mcp-agent-vX.Y.Z.apk` from the repo's **Releases** and sideload it.
2. Open the app, enter your **server URL** (e.g. `https://phone.example.com`) and the
   **token**, tap **Connect**.
3. Grant the permissions the setup screen lists:
   - **Accessibility** — needed for UI tree + gestures. On **Android 13+** sideloaded
     apps are blocked from Accessibility until you allow it manually: if you hit a
     *“Restricted setting”* dialog, go to **Settings → Apps → Phone MCP Agent → ⋮ →
     Allow restricted settings**, then enable it under **Accessibility**.
   - **Screen capture** — the system consent dialog (per-session on Android 15+).
   - **Battery optimization** — disable it so the connection survives the screen
     turning off (important on Xiaomi/Oppo/Vivo/Samsung).

When connected, the phone appears in the broker's device registry.

---

## 3. Wire up the MCP

The MCP runs **locally next to your agent** (stdio) and talks to the broker over HTTP.

```jsonc
// e.g. claude_desktop_config.json / your MCP client config
{
  "mcpServers": {
    "phone": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/phone-mcp/packages/mcp/src/index.ts"],
      "env": {
        "PHONE_MCP_SERVER_URL": "https://phone.example.com",
        "PHONE_MCP_TOKEN": "the-same-token-as-the-server"
      }
    }
  }
}
```

### Tools exposed to the agent

| Tool | What it does |
|---|---|
| `list_devices` | List connected phones + status |
| `get_device_status` / `device_info` | Status / hardware info for one device |
| `snapshot` | **Preferred.** Compact text view of the screen: one line per element with a ref like `[n12]`, role, label, flags. Capped (300 lines / ~12 KB), narrow with `within: <ref>` |
| `screenshot` | Image of the screen, only for visual content (video, photos, canvas). Defaults 540px / JPEG q60 (typically < 60 KB) |
| `open_url` | Open a URL / deep link via Intent (preferred for links/profiles) |
| `tap` / `long_press` | By `ref` (from `snapshot`) or x,y |
| `click_node` | By `ref`, or by viewId/text |
| `type_text` | Type into the focused field, or into `ref` (focused first) |
| `swipe` / `scroll` | Gestures |
| `global_action` | back / home / recents / notifications |
| `ui_tree` | Raw JSON accessibility tree (large; prefer `snapshot`) |

Action tools return one line plus a hint (`now: <app> — "<screen title>" (screen changed)`),
so you rarely need a snapshot after every step; pass `hint: false` to skip it. A `ref` that no longer
matches the screen returns a readable `stale ref` error: take a new snapshot. The compact snapshot,
refs and hints are implemented in the HTTP `/mcp` endpoint (the stdio package has the new screenshot
defaults only).

If exactly one phone is online, the `deviceId` argument is optional.

---

## 4. Releases & versioning

Versioning is deliberately boring: **the root `package.json` `version` is the single
source of truth.**

- Every push to `main` checks whether the tag `v<version>` already exists.
  - **New version** → the Release workflow builds the APK, tags `v<version>`,
    publishes a GitHub Release with the APK attached, and pushes the server image to
    `ghcr.io/<owner>/<repo>`.
  - **Already tagged** → nothing happens.

To cut a release, bump and merge to `main`:

```bash
bun run bump patch   # or: minor | major | 1.4.2
git commit -am "release: v$(node -p "require('./package.json').version")"
git push              # onto main (or via PR)
```

`versionCode` for the APK is derived deterministically from the semver
(`major*1_000_000 + minor*1_000 + patch`), so it always increases.

### Signing the APK (optional)

By default the release APK is **debug-signed** so it installs with zero setup. For a
stable signature across releases (so users can update in place), add these repo
secrets and the workflow will use them automatically:

`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`.

---

## Developing

```bash
bun install
bun run typecheck      # all three TS packages
bun run test           # snapshot builder + MCP tool tests
bun run server:dev     # broker with --watch
```

The Android app opens as a standard Android Studio project in `android/`.

## Limits & gotchas

- `FLAG_SECURE` screens (banking, DRM video) show black in screenshots — normal.
- MediaProjection consent is **per-session** on Android 15+; re-grant if it stops.
- UI tree is for navigation; media content (e.g. video feeds) isn't in it — use
  screenshots + vision for "what's on screen".
- One phone = one session; parallel work needs more phones.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the complete rationale.

## License

MIT
