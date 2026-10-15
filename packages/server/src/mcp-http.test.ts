import { describe, expect, test } from "bun:test";
import { searchScreen } from "../../shared/src/snapshot.fixture.ts";
import { handleMcp } from "./mcp-http.ts";
import type { DeviceRegistry } from "./registry.ts";

function fakeReg(tree: () => unknown, log: Array<{ cmd: string; args: unknown }> = [], id = "d1"): DeviceRegistry {
  return {
    list: () => [{ deviceId: id }],
    sendCommand: async (_id: string, cmd: string, args: unknown) => {
      log.push({ cmd, args });
      if (cmd === "ui_tree") return { ok: true, data: { tree: tree() } };
      if (cmd === "screenshot") return { ok: true, data: { image: "A".repeat(4000), mime: "image/jpeg", w: 540, h: 1200 } };
      return { ok: true, data: {} };
    },
  } as unknown as DeviceRegistry;
}

async function call(reg: DeviceRegistry, name: string, args: Record<string, unknown> = {}) {
  const res = await handleMcp(
    new Request("http://x/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    reg,
  );
  const body = (await res.json()) as { result: { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean } };
  return body.result;
}

describe("mcp snapshot + refs", () => {
  test("snapshot then tap by ref hits the node center and adds a hint", async () => {
    const log: Array<{ cmd: string; args: any }> = [];
    const reg = fakeReg(() => searchScreen, log);
    const snap = await call(reg, "snapshot");
    const line = snap.content[0]!.text!.split("\n").find((l) => l.includes('"Cart"'))!;
    const ref = /\[(n\d+)\]/.exec(line)![1]!;
    const out = await call(reg, "tap", { ref });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain(`Tapped ${ref} "Cart" at (540, 2260)`);
    expect(out.content[0]!.text).toContain('now: com.example.shop — "Search results"');
    expect(log.find((l) => l.cmd === "tap")!.args).toEqual({ x: 540, y: 2260 });
  });

  test("stale ref and missing snapshot are readable errors", async () => {
    let tree: any = searchScreen;
    const reg = fakeReg(() => tree, [], "d-stale");
    const none = await call(reg, "tap", { ref: "n1" });
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain("call `snapshot` first");

    const snap = await call(reg, "snapshot");
    const ref = /\[(n\d+)\] .*"Cart"/.exec(snap.content[0]!.text!)![1]!;
    tree = { class: "android.widget.FrameLayout", pkg: "other", bounds: { l: 0, t: 0, r: 10, b: 10 } };
    const stale = await call(reg, "tap", { ref, hint: false });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("stale ref");
  });

  test("type_text with ref taps first, then types", async () => {
    const log: Array<{ cmd: string; args: any }> = [];
    const reg = fakeReg(() => searchScreen, log);
    const snap = await call(reg, "snapshot");
    const ref = /\[(n\d+)\] input/.exec(snap.content[0]!.text!)![1]!;
    await call(reg, "type_text", { text: "boots", ref, hint: false });
    expect(log.map((l) => l.cmd).filter((c) => c !== "ui_tree")).toEqual(["tap", "type_text"]);
  });

  test("screenshot defaults are small and returned as an image part", async () => {
    const log: Array<{ cmd: string; args: any }> = [];
    const out = await call(fakeReg(() => searchScreen, log), "screenshot");
    expect(log[0]!.args).toMatchObject({ maxWidth: 540, quality: 60, format: "jpeg" });
    expect(out.content[0]!.text).toContain("540×1200");
    expect(out.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });
});
