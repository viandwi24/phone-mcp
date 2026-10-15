/**
 * Compact UI snapshot: turns the (large, JSON) accessibility tree into one text
 * line per meaningful node, like a browser accessibility snapshot, and resolves
 * the short refs (`n12`) it hands out back to on-screen nodes.
 *
 * Pure functions only — no I/O — so they are unit-tested over fixture trees.
 */
import type { Bounds, UiNode } from "./index.ts";

export const DEFAULT_MAX_LINES = 300;
export const DEFAULT_MAX_CHARS = 12_000;
const LABEL_MAX = 80;

/** What we remember about an emitted node so a ref can be re-found later. */
export interface RefEntry {
  /** e.g. "n12" (pre-order index of the node in the full tree) */
  ref: string;
  index: number;
  /** class|viewId|text|desc — used to re-find the node in a fresh tree */
  sig: string;
  /** true when sig holds more than the class (viewId, text or desc) */
  distinctive: boolean;
  bounds: Bounds;
  label: string;
}

export interface Snapshot {
  text: string;
  refs: RefEntry[];
  pkg?: string;
  title?: string;
  /** hash of every meaningful line (before any cap) — cheap "did the screen change" check */
  fingerprint: string;
  /** meaningful nodes found / lines shown */
  total: number;
  shown: number;
}

export interface SnapshotOptions {
  maxLines?: number;
  maxChars?: number;
  /** ref from an earlier snapshot: render only that node's subtree */
  within?: string;
  /** refs of the previous snapshot (needed to resolve `within`) */
  previous?: RefEntry[];
}

export type SnapshotResult = ({ ok: true } & Snapshot) | { ok: false; error: string };

const ROLES: Record<string, string> = {
  Button: "button",
  ImageButton: "imgbutton",
  TextView: "text",
  EditText: "input",
  AutoCompleteTextView: "input",
  ImageView: "image",
  CheckBox: "checkbox",
  Switch: "switch",
  SwitchCompat: "switch",
  ToggleButton: "switch",
  RadioButton: "radio",
  RecyclerView: "list",
  ListView: "list",
  GridView: "grid",
  ScrollView: "scroll",
  HorizontalScrollView: "scroll",
  NestedScrollView: "scroll",
  ViewPager: "pager",
  ViewPager2: "pager",
  WebView: "web",
  ProgressBar: "progress",
  SeekBar: "slider",
  Toolbar: "toolbar",
  Spinner: "select",
  TabWidget: "tabs",
};

function roleOf(n: UiNode): string {
  const last = (n.class ?? "").split(/[.$]/).pop() ?? "";
  const known = ROLES[last];
  if (known) return known;
  if (/^(View|ViewGroup|FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|CardView)$/.test(last) || !last) {
    return "view";
  }
  return last.toLowerCase();
}

function clip(s: string, max = LABEL_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function visible(n: UiNode): boolean {
  const b = n.bounds;
  return !b || (b.r > b.l && b.b > b.t);
}

function interactive(n: UiNode): boolean {
  return !!(n.clickable || n.editable || n.scrollable || n.checkable || n.checked);
}

function ownLabel(n: UiNode): string {
  return clip(n.text || n.desc || "");
}

function sigOf(n: UiNode): string {
  return [n.class ?? "", n.viewId ?? "", n.text ?? "", n.desc ?? ""].join("|");
}

function entryOf(n: UiNode, index: number, label: string): RefEntry {
  return {
    ref: `n${index}`,
    index,
    sig: sigOf(n),
    distinctive: !!(n.viewId || n.text || n.desc),
    bounds: n.bounds ?? { l: 0, t: 0, r: 0, b: 0 },
    label,
  };
}

/** Pre-order numbering over the FULL tree so refs stay stable under `within`. */
function number(tree: UiNode): Map<UiNode, number> {
  const m = new Map<UiNode, number>();
  const walk = (n: UiNode): void => {
    m.set(n, m.size);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return m;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function shortId(viewId: string): string {
  const i = viewId.indexOf(":id/");
  return i >= 0 ? viewId.slice(i + 4) : viewId;
}

/** Texts of non-interactive descendants (stops at interactive ones). */
function collectLabels(n: UiNode, absorbed: Set<UiNode>, out: string[]): void {
  for (const c of n.children ?? []) {
    if (out.length >= 3) return;
    if (interactive(c) || !visible(c)) continue;
    const l = ownLabel(c);
    if (l) {
      out.push(l);
      absorbed.add(c);
    }
    collectLabels(c, absorbed, out);
  }
}

function findNode(tree: UiNode, pred: (n: UiNode) => boolean): UiNode | undefined {
  if (pred(tree)) return tree;
  for (const c of tree.children ?? []) {
    const r = findNode(c, pred);
    if (r) return r;
  }
  return undefined;
}

/** Re-find an old ref in a fresh tree. Same signature, nearest to where it was. */
export function resolveRef(
  saved: RefEntry[] | undefined,
  ref: string,
  fresh: UiNode,
): { ok: true; node: UiNode; x: number; y: number; entry: RefEntry } | { ok: false; error: string } {
  if (!saved || saved.length === 0) {
    return { ok: false, error: "no snapshot taken yet for this device — call `snapshot` first, then use its refs" };
  }
  const entry = saved.find((e) => e.ref === ref);
  if (!entry) {
    return { ok: false, error: `unknown ref "${ref}" — not in the latest snapshot; take a new snapshot` };
  }
  const stale = { ok: false as const, error: `stale ref ${ref} ("${entry.label}") — the screen changed; take a new snapshot` };
  let best: UiNode | undefined;
  let bestDist = Infinity;
  const cx = (entry.bounds.l + entry.bounds.r) / 2;
  const cy = (entry.bounds.t + entry.bounds.b) / 2;
  const walk = (n: UiNode): void => {
    if (n.bounds && visible(n) && sigOf(n) === entry.sig) {
      const b = n.bounds;
      const same = b.l === entry.bounds.l && b.t === entry.bounds.t && b.r === entry.bounds.r && b.b === entry.bounds.b;
      if (same || entry.distinctive) {
        const d = same ? 0 : Math.hypot((b.l + b.r) / 2 - cx, (b.t + b.b) / 2 - cy);
        if (d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(fresh);
  if (!best || !best.bounds) return stale;
  const b = best.bounds;
  return { ok: true, node: best, x: Math.round((b.l + b.r) / 2), y: Math.round((b.t + b.b) / 2), entry };
}

export function buildSnapshot(tree: UiNode, opts: SnapshotOptions = {}): SnapshotResult {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const index = number(tree);

  let root = tree;
  if (opts.within) {
    const r = resolveRef(opts.previous, opts.within, tree);
    if (!r.ok) return r;
    root = r.node;
  }

  const lines: string[] = [];
  const refs: RefEntry[] = [];
  const absorbed = new Set<UiNode>();
  const allLabels: string[] = [];
  let total = 0;
  let chars = 0;
  let capped = false;
  let firstCapRef: string | undefined;
  let title: string | undefined;
  let titleAny: string | undefined;
  const screenH = tree.bounds?.b ?? 0;

  const walk = (n: UiNode, depth: number): void => {
    if (absorbed.has(n)) {
      for (const c of n.children ?? []) walk(c, depth);
      return;
    }
    const vis = visible(n);
    let label = ownLabel(n);
    const meaningful = vis && (interactive(n) || !!label || n.focused || n.selected);
    let childDepth = depth;
    if (meaningful) {
      if (!label && n.clickable) {
        const parts: string[] = [];
        collectLabels(n, absorbed, parts);
        label = clip(parts.join(" | "));
      }
      total++;
      const i = index.get(n) ?? 0;
      const flags: string[] = [];
      if (n.clickable) flags.push("clickable");
      if (n.focused) flags.push("focused");
      if (n.checked) flags.push("checked");
      else if (n.checkable) flags.push("unchecked");
      if (n.selected) flags.push("selected");
      if (n.scrollable) flags.push("scrollable");
      if (n.editable) flags.push("editable");
      const line =
        `${"  ".repeat(Math.min(depth, 12))}[n${i}] ${roleOf(n)}` +
        (label ? ` "${label}"` : "") +
        (n.viewId ? ` #${clip(shortId(n.viewId), 40)}` : "") +
        (flags.length ? ` [${flags.join(",")}]` : "");
      allLabels.push(`${roleOf(n)}:${label}:${flags.join("")}`);
      if (!titleAny && label && !interactive(n)) titleAny = label;
      if (!title && label && !interactive(n) && n.bounds && screenH && n.bounds.t < screenH * 0.2) title = label;
      if (!capped && lines.length < maxLines && chars + line.length + 1 <= maxChars) {
        lines.push(line);
        refs.push(entryOf(n, i, label));
        chars += line.length + 1;
      } else if (!capped) {
        capped = true;
        firstCapRef = `n${i}`;
      }
      childDepth = depth + 1;
    }
    for (const c of n.children ?? []) walk(c, childDepth);
  };
  walk(root, 0);

  const pkg = tree.pkg ?? findNode(tree, (n) => !!n.pkg)?.pkg;
  const shown = lines.length;
  const head = `app: ${pkg ?? "unknown"} | screen: ${title ?? titleAny ?? "(untitled)"} | ${shown}/${total} nodes${opts.within ? ` within ${opts.within}` : ""}`;
  let text = lines.length ? `${head}\n${lines.join("\n")}` : `${head}\n(no meaningful nodes — the screen may be media/canvas; use \`screenshot\`)`;
  if (total > shown) {
    text += `\n… ${total - shown} more nodes (from ${firstCapRef ?? "?"}), scroll or narrow with \`within: <ref>\``;
  }
  return {
    ok: true,
    text,
    refs,
    pkg,
    title: title ?? titleAny,
    fingerprint: hash(`${pkg ?? ""}#${allLabels.join("\n")}`),
    total,
    shown,
  };
}

/** Cheap one-line description of the current screen, for post-action hints. */
export function describeScreen(tree: UiNode): { pkg?: string; title?: string; fingerprint: string } {
  const r = buildSnapshot(tree, { maxLines: 0 });
  if (!r.ok) return { fingerprint: "" };
  return { pkg: r.pkg, title: r.title, fingerprint: r.fingerprint };
}
