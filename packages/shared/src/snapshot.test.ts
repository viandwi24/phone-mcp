import { describe, expect, test } from "bun:test";
import { buildSnapshot, describeScreen, resolveRef } from "./snapshot.ts";
import { bigTree, searchScreen } from "./snapshot.fixture.ts";
import type { UiNode } from "./index.ts";

function snap(tree: UiNode, o = {}) {
  const r = buildSnapshot(tree, o);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("buildSnapshot", () => {
  const r = snap(searchScreen);

  test("one line per meaningful node, with header and title", () => {
    expect(r.text.split("\n")[0]).toBe("app: com.example.shop | screen: Search results | 17/17 nodes");
    expect(r.text).toContain('[n3] imgbutton "Navigate up" [clickable]');
    expect(r.text).toContain('input "running shoes" #search_input [clickable,focused,editable]');
    expect(r.text).toContain('checkbox "Favorite" [clickable,checked]');
    expect(r.text).toContain('checkbox "Favorite" [clickable,unchecked]');
    expect(r.text).toContain('text "All" [clickable,selected]');
    expect(r.title).toBe("Search results");
  });

  test("collapses wrappers and drops zero-size / empty nodes", () => {
    expect(r.text).not.toContain("image");
    expect(r.text).not.toContain("framelayout");
    // toolbar wrapper is not emitted, so its children are not indented under it
    expect(r.text).toMatch(/\n\[n3\] imgbutton/);
  });

  test("clickable card absorbs its text children into its label", () => {
    expect(r.text).toContain('view "Trail Runner X | $89.00" #card [clickable]');
    expect(r.text).not.toContain('text "Trail Runner X"');
    // indented one level under the list
    expect(r.text).toMatch(/\n {2}\[n\d+\] view "Road Glide 3 \| \$120.00"/);
  });

  test("is far smaller than the JSON tree", () => {
    expect(r.text.length).toBeLessThan(JSON.stringify(searchScreen).length / 3);
  });

  test("clips long labels to ~80 chars", () => {
    const t: UiNode = {
      class: "android.widget.TextView",
      text: "x".repeat(500),
      pkg: "p",
      bounds: { l: 0, t: 0, r: 10, b: 10 },
    };
    const line = snap(t).text.split("\n")[1]!;
    expect(line.length).toBeLessThan(110);
    expect(line).toContain("…");
  });

  test("hard cap on lines with a hint to narrow", () => {
    const s = snap(bigTree(500), { maxChars: 1_000_000 });
    expect(s.shown).toBe(300);
    expect(s.total).toBe(500);
    expect(s.text).toContain("… 200 more nodes");
    const byChars = snap(bigTree(500)); // default ~12 KB cap kicks in first
    expect(byChars.text.length).toBeLessThan(12_400);
    expect(byChars.shown).toBeLessThan(300);
    expect(s.text).toContain("within: <ref>");
    const small = snap(bigTree(500), { maxChars: 2000 });
    expect(small.text.length).toBeLessThan(2400);
    expect(small.shown).toBeLessThan(300);
  });

  test("within renders just that subtree, with the same ref numbers", () => {
    const list = r.refs.find((e) => e.label === "" && e.sig.includes("RecyclerView"))!;
    const sub = snap(searchScreen, { within: list.ref, previous: r.refs });
    expect(sub.text).toContain(`within ${list.ref}`);
    expect(sub.text).toContain("Sprint Pro");
    expect(sub.text).not.toContain("Navigate up");
    const road = r.refs.find((e) => e.label.startsWith("Road Glide"))!;
    expect(sub.refs.find((e) => e.label.startsWith("Road Glide"))!.ref).toBe(road.ref);
  });

  test("within with an unknown ref is a readable error", () => {
    const e = buildSnapshot(searchScreen, { within: "n999", previous: r.refs });
    expect(e.ok).toBe(false);
  });

  test("empty / media screens say so", () => {
    const t: UiNode = { class: "android.widget.FrameLayout", pkg: "tv", bounds: { l: 0, t: 0, r: 100, b: 100 } };
    expect(snap(t).text).toContain("use `screenshot`");
  });

  test("fingerprint changes only when the screen changes", () => {
    expect(describeScreen(searchScreen).fingerprint).toBe(r.fingerprint);
    const changed = structuredClone(searchScreen);
    changed.children![0]!.children![1]!.text = "boots";
    expect(describeScreen(changed).fingerprint).not.toBe(r.fingerprint);
  });
});

describe("resolveRef", () => {
  const r = snap(searchScreen);
  const cart = r.refs.find((e) => e.label === "Cart")!;

  test("resolves to the bounds center of the matching node", () => {
    const x = resolveRef(r.refs, cart.ref, searchScreen);
    expect(x).toMatchObject({ ok: true, x: 540, y: 2260 });
  });

  test("follows a node that moved (scrolled) when it is distinctive", () => {
    const moved = structuredClone(searchScreen);
    const list = moved.children![0]!.children![3]!;
    for (const c of list.children!) {
      c.bounds = { ...c.bounds!, t: c.bounds!.t - 200, b: c.bounds!.b - 200 };
    }
    const road = r.refs.find((e) => e.label.startsWith("Road Glide"))!;
    const x = resolveRef(r.refs, road.ref, moved);
    expect(x.ok).toBe(true);
  });

  test("stale when the node is gone", () => {
    const gone = structuredClone(searchScreen);
    gone.children![0]!.children!.pop(); // remove bottom nav
    const x = resolveRef(r.refs, cart.ref, gone);
    expect(x).toMatchObject({ ok: false });
    expect((x as { error: string }).error).toContain("take a new snapshot");
  });

  test("unlabeled nodes need identical bounds", () => {
    const t: UiNode = {
      class: "android.widget.FrameLayout",
      pkg: "p",
      bounds: { l: 0, t: 0, r: 100, b: 100 },
      children: [{ class: "android.widget.ImageButton", clickable: true, bounds: { l: 0, t: 0, r: 10, b: 10 } }],
    };
    const s = snap(t);
    const ref = s.refs[0]!.ref;
    expect(resolveRef(s.refs, ref, t).ok).toBe(true);
    const moved = structuredClone(t);
    moved.children![0]!.bounds = { l: 50, t: 50, r: 60, b: 60 };
    expect(resolveRef(s.refs, ref, moved).ok).toBe(false);
  });

  test("no snapshot yet / unknown ref", () => {
    expect(resolveRef(undefined, "n1", searchScreen)).toMatchObject({ ok: false });
    const e = resolveRef(r.refs, "n9999", searchScreen) as { error: string };
    expect(e.error).toContain("unknown ref");
  });
});
