# Android Remote Control APK — Arsitektur

> Dokumen desain untuk sistem remote control Android tanpa ADB & tanpa root.
> Konsep: enkaku (ADB-based) → dipindah seluruhnya ke dalam APK yang jalan di device.
> Konsumen akhir: **AI agent** yang mengirim perintah lewat server untuk research/checking (buka link TikTok, cek profil, screenshot, baca layar).

---

## 1. Tujuan & Prinsip

**Tujuan:** User cukup install 1 APK → APK konek ke server (Bun/TS) → server (yang dikendalikan AI agent) bisa kirim perintah: screenshot, baca UI tree, tap/swipe/type, buka URL/deep link.

**Prinsip desain yang membentuk arsitektur:**

1. **No ADB, no root.** Semua kapabilitas enkaku dipindah ke 3 API Android: MediaProjection (layar), AccessibilityService (baca UI + gesture), Intent (buka app/URL).
2. **Intent-first, bukan tap-buta.** Untuk "buka link/profil TikTok", pakai `startActivity` deep link — jauh lebih reliable daripada meniru klik koordinat. Tap/swipe hanya untuk interaksi yang tak punya deep link (scroll feed, dsb).
3. **Vision-first untuk "melihat konten".** UI tree TikTok miskin (video = surface, bukan view native). AI "lihat" lewat **screenshot + vision model**, bukan UI tree. UI tree hanya untuk navigasi.
4. **Server = broker stateless-ish.** Server tidak menyimpan logika; dia routing command dari AI agent ke device dan mem-forward hasil. State sesi (device online/offline) ada di registry in-memory.

---

## 2. Arsitektur Tingkat Tinggi

Tiga pihak:

| Pihak | Peran | Teknologi |
|---|---|---|
| **AI Agent** | Pengirim perintah tingkat tinggi ("cek link ini", "buka profil X") | MCP client (consumer dari server API) |
| **Server** | Broker: terima command dari agent, kirim ke device, forward hasil balik | `Bun.serve` + WebSocket |
| **APK** | Eksekutor di device: capture layar, baca UI, gesture, launch intent | Kotlin, Foreground Service |

Implementasi di repo ini:

- AI agent bicara ke server lewat **MCP** (`packages/mcp`, stdio) yang di belakang layar memakai **HTTP request/response** ke server.
- Device bicara ke server lewat **WebSocket** persisten (`/device`).

---

## 3. Arsitektur Internal APK

```
APK
├── SetupActivity ............ onboarding: minta izin, tampilkan status koneksi
├── RemoteForegroundService .. inti: nahan koneksi WS, dispatch command, notifikasi persisten
│   ├── WsClient ............. koneksi WebSocket ke server (auto-reconnect)
│   ├── (CommandDispatcher) .. parse command → panggil modul yang tepat
│   ├── ScreenCapturer ....... MediaProjection → VirtualDisplay → frame (JPEG)
│   └── LaunchBridgeActivity . startActivity untuk buka URL/deep link
└── RemoteAccessibilityService  AccessibilityService terpisah (lifecycle sendiri)
    ├── UiTree ............... baca AccessibilityNodeInfo → JSON
    └── Gesture .............. dispatchGesture (tap/swipe/longpress) + global actions
```

### 3.1 RemoteForegroundService (jantung)

- **Kenapa Foreground:** service biasa dibunuh OS saat layar mati / low memory. Foreground service dengan notifikasi persisten bertahan. Android 14+ wajib `foregroundServiceType` (`mediaProjection`).
- **Auto-reconnect:** exponential backoff saat koneksi putus + heartbeat (ping/pong).

### 3.2 WsClient
- Satu WebSocket persisten (OkHttp). Outbound: `register`, `pong`, `result`. Inbound: `command`, `ping`, `registered`.

### 3.3 ScreenCapturer (MediaProjection)
- `ImageReader` + `VirtualDisplay` → ambil 1 frame saat command `screenshot` → encode JPEG/PNG → base64. Downscale ke `maxWidth` untuk hemat bandwidth.

### 3.4 RemoteAccessibilityService
- **UI tree:** dari `rootInActiveWindow`, rekursif, tiap node: `text`, `desc`, `class`, `viewId`, `bounds`, `clickable`, `scrollable`, `editable`, `pkg`.
- **Gesture:** `dispatchGesture()` (tap/swipe/longpress), node actions (`ACTION_CLICK`/`ACTION_SET_TEXT`), global actions (back/home/recents/notifications).

### 3.5 LaunchBridgeActivity
- Activity transparan untuk `startActivity(ACTION_VIEW)` — menghindari batasan background-activity-start di Android 10+.

---

## 4. Setup & Permission Flow

1. **Install APK** (sideload).
2. **Izinkan "Restricted settings"** (Android 13+) agar Accessibility bisa diaktifkan untuk app sideload.
3. **Enable Accessibility Service.**
4. **Grant MediaProjection consent** (per-sesi di Android 15+).
5. **Matikan Battery Optimization** (penting di OEM agresif).
6. **(Opsional) Auto-start / boot.**

---

## 5. Arsitektur Server (Bun/TS)

```
Server (Bun)
├── WS endpoint  /device ....... koneksi dari APK (token-guarded)
├── API endpoint /api/... ....... koneksi dari MCP/agent (token-guarded)
├── DeviceRegistry ............. Map<deviceId, { ws, status, lastSeen }>
└── CommandRouter .............. correlate command→result via reqId + timeout
```

- **Auth:** satu token (`PHONE_MCP_TOKEN`) untuk device WS (`?token=` / `Authorization`) dan agent API (`Bearer`).
- **CommandRouter:** tiap command punya `reqId`; server simpan resolver per `reqId`; `result` dengan `reqId` sama → resolve; timeout bila device diam.

---

## 6. Protokol / Message Schema (kontrak WS)

**Transport:** WebSocket. Pesan **JSON**; screenshot dikirim sebagai `result` yang `data`-nya base64 (sederhana untuk agent). Tiap command punya `reqId`.

### 6.1 Device → Server
```jsonc
{ "type": "register", "deviceId": "...", "model": "...", "androidVersion": 34,
  "screen": { "w": 1080, "h": 2400 }, "caps": { "projection": true, "accessibility": true } }
{ "type": "result", "reqId": "uuid", "ok": true, "data": { /* per-command */ } }
{ "type": "pong", "ts": 1700000000 }
```

### 6.2 Server → Device
```jsonc
{ "type": "command", "reqId": "uuid", "cmd": "<nama>", "args": { /* ... */ } }
{ "type": "ping", "ts": 1700000000 }
{ "type": "registered", "ok": true }
```

### 6.3 Katalog Command

| `cmd` | `args` | Hasil (`data`) |
|---|---|---|
| `screenshot` | `{ format?, quality?, maxWidth? }` | `{ image: base64, mime, w, h }` |
| `ui_tree` | `{ maxDepth?, visibleOnly? }` | `{ tree: Node }` |  <!-- `snapshot` dan aksi-by-ref hanya ada di broker, bukan command device -->
| `tap` | `{ x, y }` | `{ dispatched }` |
| `swipe` | `{ x1, y1, x2, y2, durationMs? }` | `{ dispatched }` |
| `long_press` | `{ x, y, durationMs? }` | `{ dispatched }` |
| `scroll` | `{ direction, amount? }` | `{ dispatched }` |
| `type_text` | `{ text }` | `{ ok }` |
| `click_node` | `{ viewId?, text?, index? }` | `{ clicked }` |
| `open_url` | `{ url, package? }` | `{ launched }` |
| `global_action` | `{ action }` | `{ ok }` |
| `device_info` | `{}` | `{ model, androidVersion, screen, ... }` |

### 6.4 Struktur `Node`
```jsonc
{
  "class": "android.widget.Button", "text": "Follow", "desc": "...",
  "viewId": "com.app:id/follow", "pkg": "com.zhiliaoapp.musically",
  "bounds": { "l": 120, "t": 1800, "r": 300, "b": 1880 },
  "clickable": true, "scrollable": false, "editable": false,
  "checkable": false, "checked": false, "focused": false, "selected": false,  // opsional, hanya bila true
  "children": [ /* ... */ ]
}
```

### 6.5 Snapshot ringkas & ref (sisi broker)

Tree JSON dari device bisa 10-30 KB, jadi endpoint `/mcp` membangun **snapshot teks** di broker
(`packages/shared/src/snapshot.ts`, fungsi murni): satu baris per node bermakna (clickable /
editable / scrollable / checkable / punya text atau desc), diindent menurut kedalaman, wrapper
layout kosong dan node ukuran nol dilipat. Tiap baris punya ref `[nK]` (K = indeks pre-order di
seluruh tree, jadi tetap stabil saat `within`). Batas keras 300 baris / ~12 KB.

- Broker menyimpan per device daftar ref snapshot terakhir (in-memory, hilang saat restart).
- Aksi dengan `ref` mengambil tree baru lalu mencari node dengan signature sama
  (class|viewId|text|desc), paling dekat dengan posisi lama; node tanpa label harus punya bounds
  identik. Tidak ketemu -> error teks "stale ref, take a new snapshot". Lalu tap di titik tengah bounds.
- Hasil aksi = satu baris + hint `now: <pkg> — "<judul layar>"` (+ screen changed/unchanged via
  fingerprint), bukan tree penuh. `hint:false` untuk melewati (hemat satu round-trip ui_tree).
- `screenshot` default 540px / JPEG q60 dan dikembalikan sebagai content `image` MCP.
- APK menambah flag `checkable/checked/focused/selected` di tree (APK lama tanpa field ini tetap jalan).

---

## 7. Flow Contoh

**Cek link TikTok:** `open_url { url }` → (jeda ~1.5–2s) → `screenshot` → AI vision baca ("tersedia / private / dihapus / 404").

**Buka profil & lihat:** `open_url { url: "https://www.tiktok.com/@username" }` → `screenshot` → (opsional) `scroll down` → `screenshot` lagi.

---

## 8. Peta Kesetaraan: enkaku (ADB) → APK

| Fungsi enkaku | ADB | Pengganti di APK |
|---|---|---|
| Casting layar | `screencap` / scrcpy | MediaProjection + VirtualDisplay |
| Tap/swipe/text | `input ...` | AccessibilityService `dispatchGesture` |
| UI tree | `uiautomator dump` | `AccessibilityNodeInfo` |
| Back/Home/Recents | `input keyevent` | `GLOBAL_ACTION_*` |
| Buka URL | `am start -a VIEW -d <url>` | `startActivity(ACTION_VIEW)` |

---

## 9. Batasan & Hal yang Menggigit

- **`FLAG_SECURE`** → layar hitam di MediaProjection (banking, DRM). Feed/profil TikTok umumnya TIDAK FLAG_SECURE.
- **MediaProjection per-sesi (Android 15+):** handle `onStop()` dan re-request.
- **Restricted settings (Android 13+):** wajib "Allow restricted settings" untuk Accessibility.
- **Input via Accessibility lebih rapuh** daripada ADB: beri jeda, pakai `click_node` bila tree ada.
- **OS agresif membunuh service:** foreground service + whitelist battery + reconnect backoff.
- **Background activity start (Android 10+):** pakai LaunchBridgeActivity.
- **Satu device = satu sesi.**
- **UI tree TikTok miskin:** andalkan screenshot + vision.
- **Deteksi otomasi:** jaga pacing "manusiawi" untuk volume tinggi; HP fisik asli menang di anti-deteksi.

---

## 10. Anti-Detection (bila volume naik)

- Jeda acak antar aksi.
- Gesture dengan durasi & lintasan bervariasi.
- Prioritaskan `open_url` (intent) daripada rangkaian tap.
- Hindari burst; sebar sepanjang waktu.

---

## 11. Rencana Bertahap

1. **MVP:** `register` + `screenshot` + `open_url`. ✅ (diimplementasi)
2. **Interaksi:** `ui_tree` + `tap`/`swipe`/`scroll` + `global_action` + `type_text` + `click_node`. ✅
3. **Real-time:** `start_stream` (H.264 via MediaCodec) + web viewer. (future)
4. **Fleet:** multi-device registry + scheduler. (registry multi-device sudah ada)

---

## 12. Tech Stack

- **APK:** Kotlin, OkHttp WebSocket, minSdk 26, targetSdk 35.
- **Server:** Bun + TypeScript, `Bun.serve` native WebSocket.
- **MCP:** `@modelcontextprotocol/sdk` (stdio) → HTTP ke server.
- **Permission manifest kunci:** `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS`, `BIND_ACCESSIBILITY_SERVICE`, `INTERNET`.

---

## Ringkasan

APK menggantikan ADB dengan tiga API Android: **MediaProjection** (screenshot), **AccessibilityService** (UI tree + gesture), dan **Intent** (buka URL/deep link). Sebuah **Foreground Service** menahan koneksi WebSocket persisten ke server Bun yang jadi broker antara AI agent (via MCP) dan device. Jalur andalan: **`open_url` → `screenshot` → AI vision**. Tanpa root, tanpa emulator.
