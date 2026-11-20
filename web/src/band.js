// The U-turn band: one storage read drawn as two tries joined by one account.
//
// Top row, left to right: the block header, then one block of 16 discs per
// state trie node, with the key's path through the slot each node takes,
// ending at the account record. Its storage root drops down to start the
// bottom row, the storage trie, which runs right to left and ends at the
// value. The layout comes from the verifier's own steps (`traceStorage` in
// ferrotype.wasm); every verdict shown comes from ferrotype.wasm. The page
// hashes nodes itself only to show which reference each one must match.

import { ProofRejected } from "./ferrotype.js";
import { encodeHeader } from "./header.js";
import {
  keccak, fromHex, toHex, rlpItems, strip, grp, h8, short, wordShort, units, eth2,
} from "./bytes.js";

const NS = "http://www.w3.org/2000/svg";
export const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const EMPTY_TRIE_ROOT = "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";

const lower = (h) => strip(h).toLowerCase();

/**
 * The browser's verdict on one read: the header is rebuilt and hashed by
 * ferrotype.wasm and must equal the block hash; then the account and the slot
 * are proven against its state root. Never throws for a rejected proof.
 */
export function verifyRead(fe, { block, account, slot, accountProof, storageProof }) {
  const t0 = performance.now();
  const headerHex = encodeHeader(block);
  const headerBytes = headerHex.length / 2 - 1;
  const done = (r) => ({ ...r, headerBytes, ms: performance.now() - t0 });
  let hdr;
  try {
    hdr = fe.readHeader(headerHex);
  } catch (e) {
    if (e instanceof ProofRejected) return done({ ok: false, stage: "header", reason: e.reason, blockHash: block.hash });
    throw e;
  }
  if (lower(hdr.hash) !== lower(block.hash)) {
    return done({ ok: false, stage: "header", reason: "BadHeader", headerHash: hdr.hash, blockHash: block.hash });
  }
  try {
    const v = fe.readStorage({ stateRoot: hdr.stateRoot, account, slot, accountProof, storageProof });
    return done({ ok: true, stage: "proof", value: v.value, exists: v.exists, storageRoot: v.storageRoot, headerHash: hdr.hash, stateRoot: hdr.stateRoot });
  } catch (e) {
    if (e instanceof ProofRejected) return done({ ok: false, stage: "proof", reason: e.reason, headerHash: hdr.hash, stateRoot: hdr.stateRoot });
    throw e;
  }
}

/**
 * Decodes one read for drawing. `input` is `{ block, account, slot,
 * accountProof, storageProof }` (hex node lists, as eth_getProof returns
 * them); `spec` says how to word the value: `{ kind: "balance", token,
 * holder, layout, dec }` or `{ kind: "slot" }`. Throws ProofRejected when
 * ferrotype.wasm refuses the proof, since then there are no steps to draw.
 */
export function buildCase(fe, input, spec, source = "eth_getProof") {
  const { block, account, slot, accountProof, storageProof } = input;
  const headerHex = encodeHeader(block);
  const hdr = fe.readHeader(headerHex);
  const headerOk = lower(hdr.hash) === lower(block.hash);
  const tr = fe.traceStorage({ stateRoot: hdr.stateRoot, account, slot, accountProof, storageProof });
  const lists = { state: accountProof.map(fromHex), storage: storageProof.map(fromHex) };
  const starts = {};
  for (const t of ["state", "storage"]) {
    let o = 0;
    starts[t] = lists[t].map((b) => { const s = o; o += b.length; return s; });
  }
  const joined = { state: fromHex(accountProof.map(strip).join("")), storage: fromHex(storageProof.map(strip).join("")) };
  const paths = { state: keccak(fromHex(account)), storage: keccak(fromHex(strip(slot).padStart(64, "0"))) };
  const kc = { state: 0, storage: 0 };
  const nodes = tr.steps.map((s, i) => {
    let idx = s.inline ? -1 : starts[s.trie].indexOf(s.offset);
    if (idx >= 0 && lists[s.trie][idx].length !== s.length) idx = -1;
    const bytes = idx >= 0 ? lists[s.trie][idx] : joined[s.trie].subarray(s.offset, s.offset + s.length);
    const items = rlpItems(bytes);
    const n = { i, trie: s.trie, depth: s.depth, kind: s.kind, length: s.length, inline: s.inline, idx, bytes, k: kc[s.trie]++, hash: keccak(bytes), path: paths[s.trie], refAt: null };
    if (s.kind === "branch") {
      n.occ = items.slice(0, 16).map((it) => it.len > 0);
      n.want = parseInt(paths[s.trie][s.depth], 16);
      n.empty = !n.occ[n.want];
      const it = items[n.want];
      if (!n.empty && it.len === 32) n.refAt = { off: it.off, len: 32 };
    } else {
      const hp = toHex(bytes.subarray(items[0].off, items[0].off + items[0].len));
      n.key = parseInt(hp[0], 16) & 1 ? hp.slice(1) : hp.slice(2);
      const ours = paths[s.trie].slice(s.depth);
      n.ours = ours;
      const diverge = [...n.key].findIndex((c, j) => c !== ours[j]);
      if (s.kind === "leaf") {
        n.split = n.key === ours ? -1 : diverge;
        if (s.trie === "state" && n.split < 0) {
          const val = bytes.subarray(items[1].off, items[1].off + items[1].len), f = rlpItems(val);
          n.refAt = { off: items[1].off + f[2].off, len: 32 };
          n.codeHash = toHex(val.subarray(f[3].off, f[3].off + f[3].len));
        }
      } else {
        n.split = diverge;
        if (items[1].len === 32) n.refAt = { off: items[1].off, len: 32 };
      }
    }
    return n;
  });
  const state = nodes.filter((n) => n.trie === "state"), storage = nodes.filter((n) => n.trie === "storage");
  const R = {
    spec, input, source, tr, nodes, state, storage, slot, account, headerHex, hdr, headerOk, lists,
    hdrLen: headerHex.length / 2 - 1,
    block: Number(hdr.number), stateRoot: lower(hdr.stateRoot), storageRoot: lower(tr.storageRoot),
    exists: tr.exists, nonce: BigInt(tr.nonce), balance: BigInt(tr.balance),
    total: tr.steps.reduce((a, s) => a + s.length, 0),
    bytesOf: (t) => nodes.filter((n) => n.trie === t && !n.inline).reduce((a, n) => a + n.length, 0),
  };
  R.blockNo = grp(R.block);
  R.token = spec.kind === "balance" ? spec.token || "" : "";
  R.label = R.token ? `${R.token} ${short(account)}` : short(account);
  R.slotName = spec.kind === "balance" ? `balance slot of ${short(spec.holder)}` : `slot ${h8(slot)}…`;
  R.what = spec.kind === "balance" ? `${R.label} · balance slot of ${short(spec.holder)}` : `account ${short(account)} · slot ${wordShort(slot)}`;
  R.valueLabel = `value · slot ${h8(slot)}…`;
  return R;
}

/** Why a trie holds nothing on our path, from the last node the verifier accepted. */
function absenceWhy(L) {
  if (!L) return { at: 0, short: "the trie is empty", long: "The trie is empty." };
  if (L.kind === "branch") {
    const art = /^(8|11|18)/.test(String(L.length)) ? "an" : "a";
    return { at: L.depth, short: `slot ${L.want.toString(16)} is empty at nibble ${L.depth}`, long: `Nibble ${L.depth} wants slot ${L.want.toString(16)} of ${art} ${L.length}-byte branch.`, long2: "It’s empty, so nothing can sit under it." };
  }
  const at = L.depth + Math.max(0, L.split);
  const what = L.kind === "leaf" ? "the leaf holds another key" : "the extension leads elsewhere";
  return { at, short: `${what}: they split at nibble ${at}`, long: `The ${L.kind} at nibble ${L.depth} holds another path.`, long2: `It splits from ours at nibble ${at}, so nothing is stored here.` };
}

/** The value as ferrotype.wasm returned it, worded for people. */
export function describe(R, valueHex) {
  const v = BigInt(valueHex ?? 0), sp = R.spec;
  if (!R.exists) {
    const w = absenceWhy(R.state.at(-1));
    return {
      big: "0", unit: "no account",
      notes: [`Proven absent: ${short(R.account)}`, `${w.short}, so no storage`],
      line: `${short(R.account)} at block ${R.blockNo}: no account, proven: ${w.short}`,
    };
  }
  const unit = sp.kind === "balance" ? (sp.token || "base units") : "";
  const fmt = (x) => (sp.kind === "balance" ? units(x, sp.dec || 0) : (x < 1n << 53n ? grp(x) : wordShort("0x" + x.toString(16))));
  const whose = sp.kind === "balance" ? `balance of ${short(sp.holder)}` : `slot ${h8(R.slot)}… of ${short(R.account)}`;
  if (!R.storage.length) {
    return {
      big: "0", unit,
      notes: [`${short(R.account)} has no storage`, "its storage root is the empty trie: every slot is zero"],
      line: `${whose} at block ${R.blockNo}: 0, proven: the account’s storage root is the empty trie`,
    };
  }
  let amt = v, flagged = false;
  if (sp.kind === "balance" && sp.layout === 2) { flagged = v >> 255n === 1n; amt = v & ((1n << 255n) - 1n); }
  if (v === 0n) {
    const w = absenceWhy(R.storage.at(-1));
    return {
      big: "0", unit,
      notes: [`Proven zero: ${whose}`, w.short],
      line: `${whose} at block ${R.blockNo}: 0, proven: ${w.short}`,
    };
  }
  const flagNote = sp.kind === "balance" && sp.layout === 2 ? (flagged ? "top bit set: flagged" : "top bit clear: not flagged") : "";
  return {
    big: fmt(amt), unit,
    notes: [`${whose} at block ${R.blockNo}`, flagNote || (sp.kind === "slot" ? wordShort(valueHex) : "")],
    line: `${whose} at block ${R.blockNo}: ${fmt(amt)}${unit ? " " + unit : ""}${flagged ? " · top bit set: flagged" : ""}`,
  };
}

/* ---------- layout ---------- */
const meas = document.createElement("canvas").getContext("2d");
const textW = (s, font) => { meas.font = font; return meas.measureText(s).width; };
const sum = (a) => a.reduce((x, y) => x + y, 0);

function geom(R, W) {
  for (const k of [1, 0.9, 0.8, 0.7, 0.62]) {
    const G = geomAt(R, W, k);
    if (G.fits || k === 0.62) return G;
  }
}

function geomAt(R, W, k) {
  const mobile = W < 900;
  const G = { W, mobile, pos: [], fits: true };
  const p = (mobile ? 8.4 : W >= 1160 ? 13 : 12) * (mobile ? 1 : k);
  const bh = 1.5 * p + (mobile ? 3.8 : 4.6);
  const lp = (mobile ? 1.5 : 2.1) * (mobile ? 1 : k);
  Object.assign(G, { p, bh, lp });
  const wOf = (n) => (n.kind === "branch" ? 2 * bh : Math.max(2 * bh, (n.key.length - 1) * lp));
  const D = describe(R, R.tr.value);
  const vf = mobile ? 40 : 48;
  const vW = textW(D.big, `500 ${vf}px Gambetta`) + 8 + textW(D.unit, `400 ${mobile ? 14 : 15}px Switzer`);
  const nW = Math.max(...D.notes.map((s) => textW(s, "400 12px Switzer")), textW(R.valueLabel, '400 10.5px "JetBrains Mono"'));
  G.D = D; G.vf = vf; G.vW = vW; G.colW = Math.max(vW, nW);
  const cardH = 108;

  if (!mobile) {
    const headW = 118, cardW = W >= 1100 ? 268 : 252;
    const yA = 62, yB = yA + 126;
    G.yA = yA; G.yB = yB; G.H = yB + bh + 50;
    G.head = { x: 4.5, y: yA, lx: 0 };
    G.card = { x: W - cardW, y: yA - cardH / 2, w: cardW, h: cardH };
    G.entry = { x: G.card.x, y: yA };
    const chipX = G.card.x + 48, chipHalf = 40;
    const ws1 = R.state.map(wOf), s1 = sum(ws1), reg1 = G.card.x - headW;
    const g1 = (reg1 - s1) / (R.state.length + 1);
    const ws2 = R.storage.map(wOf), s2 = sum(ws2), reg2 = chipX - chipHalf - (G.colW + 30);
    const g2 = R.storage.length ? (reg2 - s2) / (R.storage.length + 1) : g1;
    G.fits = g1 >= 10 && g2 >= 10;
    const g = Math.max(10, Math.min(64, g1, g2));
    let x = headW + (reg1 - s1 - g * (R.state.length - 1)) / 2;
    R.state.forEach((n, i) => { const w = ws1[i]; G.pos[n.i] = { cx: x + w / 2, cy: yA, w, dir: 1 }; x += w + g; });
    G.chip = { x: chipX, y: yB, fx: chipX, fy: G.card.y + 92, top: G.card.y + cardH };
    x = chipX - chipHalf - g;
    R.storage.forEach((n, i) => { const w = ws2[i]; G.pos[n.i] = { cx: x - w / 2, cy: yB, w, dir: -1 }; x -= w + g; });
    G.val = { x: 0, base: yB + vf * 0.33, label: yB - vf * 0.58 - 6 };
    G.val.notes = [yB + 38, yB + 54];
    G.anchor = { x: vW + 18, y: yB };
    G.brackets = [];
    if (R.state.length) { const a = G.pos[R.state[0].i], b = G.pos[R.state.at(-1).i]; G.brackets.push({ x1: a.cx - a.w / 2, x2: b.cx + b.w / 2, y: yA + bh + 30, anchor: "start", trie: "state" }); }
    if (R.storage.length) { const a = G.pos[R.storage.at(-1).i], b = G.pos[R.storage[0].i]; G.brackets.push({ x1: a.cx - a.w / 2, x2: b.cx + b.w / 2, y: yB + bh + 30, anchor: "end", trie: "storage" }); }
    G.headLabels = [{ x: 0, y: yA - bh - 9, t: `block ${R.blockNo}`, s: true }, { x: 0, y: yA + bh + 15, t: `root ${h8(R.stateRoot)}` }, { x: 0, y: yA + bh + 29, t: `header · ${R.hdrLen} B` }];
    G.retLabel = { x: (G.colW + 30 + chipX) / 2, y: yB - 10 };
    G.headPill = { x: 18, y: yA, anchor: "start" };
  } else {
    const K = Math.max(5, Math.min(10, Math.floor(W / 58))), sw = W / K, LH = 2 * bh + 40;
    const slots = (n) => (n.kind === "branch" ? 1 : Math.min(K, Math.ceil((wOf(n) + 16) / sw)));
    const run = (items, y0) => {
      let used = 0, dir = 1, y = y0;
      for (const it of items) {
        const s = it.slots;
        if (used + s > K) { used = 0; dir = -dir; y += LH; }
        const c = (used + s / 2) * sw;
        it.cx = dir > 0 ? c : W - c; it.cy = y; it.dir = dir; used += s;
      }
      return y;
    };
    const wOfM = (n) => Math.min(wOf(n), W - 24);
    const yS = 28 + 22 + bh;
    const head = { slots: 1 };
    const sItems = [head, ...R.state.map((n) => ({ n, slots: slots(n) }))];
    const yLastS = run(sItems, yS);
    G.head = { x: head.cx, y: head.cy, lx: 0 };
    for (const it of sItems.slice(1)) G.pos[it.n.i] = { cx: it.cx, cy: it.cy, w: wOfM(it.n), dir: it.dir };
    const cardY = yLastS + bh + 30;
    G.card = { x: 0, y: cardY, w: Math.min(W, 460), h: cardH };
    let yEnd = cardY + cardH;
    G.brackets = [{ x1: 0, x2: W, y: 12, anchor: "start", trie: "state", noLine: true }];
    if (R.storage.length) {
      const chip = { slots: 1 };
      const gItems = [chip, ...R.storage.map((n) => ({ n, slots: slots(n) }))];
      const yLastG = run(gItems, cardY + cardH + 26 + 22 + bh);
      G.chip = { x: 36, y: chip.cy, fx: 44, fy: cardY + 92, top: cardY + cardH };
      for (const it of gItems.slice(1)) G.pos[it.n.i] = { cx: it.cx, cy: it.cy, w: wOfM(it.n), dir: it.dir };
      G.brackets.push({ x1: 64, x2: W, y: cardY + cardH + 26, anchor: "start", trie: "storage", noLine: true });
      yEnd = yLastG + bh;
    }
    const top = yEnd + 40;
    G.val = { x: 0, label: top, base: top + 40, notes: [top + 62, top + 78] };
    G.H = top + 90;
    G.headLabels = [{ x: 0, y: 28, t: `block ${R.blockNo} · header ${R.hdrLen} B · root ${h8(R.stateRoot)}`, s: true }];
    G.retLabel = { x: W / 2, y: cardY + cardH + 28 };
    G.headPill = { x: Math.max(4, G.head.x - 4), y: G.head.y + bh + 16, anchor: "start" };
  }
  // trail points
  const take = (n) => {
    const P = G.pos[n.i];
    if (n.kind === "branch") { const s = n.want, col = s % 4, row = s >> 2; return [{ x: P.cx + (col - 1.5) * p, y: P.cy + (row - 1.5) * p, i: n.i }]; }
    const x0 = P.cx - (P.dir * P.w) / 2, x1 = P.cx + (P.dir * P.w) / 2;
    return [{ x: x0, y: P.cy, i: n.i }, { x: x1, y: P.cy, i: n.i, gap: true }];
  };
  // a serpentine turn on narrow screens goes round the edge, not through the labels
  const push = (arr, pts) => {
    const last = arr.at(-1);
    if (G.mobile && last && Math.abs(pts[0].y - last.y) > 2 * bh) {
      const side = pts[0].x > W / 2 ? W - 2 : 2;
      arr.push({ x: side, y: last.y }, { x: side, y: pts[0].y });
    }
    arr.push(...pts);
  };
  G.seg1 = [{ x: G.head.x, y: G.head.y }];
  for (const n of R.state) push(G.seg1, take(n));
  if (G.mobile) {
    const e = G.seg1.at(-1), ex = Math.max(22, Math.min(G.card.w - 22, e.x));
    if (ex !== e.x) G.seg1.push({ x: ex, y: e.y });
    G.entry = { x: ex, y: G.card.y };
  }
  G.seg1.push({ x: G.entry.x, y: G.entry.y });
  G.seg2 = [];
  if (R.exists && R.storage.length) {
    G.seg2.push({ x: G.chip.x, y: G.chip.top }, { x: G.chip.x, y: G.chip.y });
    for (const n of R.storage) push(G.seg2, take(n));
    if (G.mobile) {
      const e = G.seg2.at(-1), y = G.val.label - 14;
      G.seg2.push({ x: e.x, y });
      if (e.x > 12) G.seg2.push({ x: 4, y });
      G.anchor = { x: 4, y };
    } else G.seg2.push({ x: G.anchor.x, y: G.anchor.y });
  }
  if (G.mobile && !G.anchor) G.anchor = { x: 4, y: G.val.label - 14 };
  G.ptOf = {};
  G.seg1.forEach((pt, j) => { if (pt.i != null) G.ptOf[pt.i] = [1, j]; });
  G.seg2.forEach((pt, j) => { if (pt.i != null) G.ptOf[pt.i] = [2, j]; });
  return G;
}

/* ---------- drawing helpers ---------- */
export function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function txt(parent, x, y, s, cls, anchor = "start") {
  const t = el("text", { x, y, class: cls, "text-anchor": anchor }, parent);
  t.textContent = s;
  return t;
}
function runsOf(points) {
  const runs = [];
  let cur = null, acc = 0;
  const lens = [0];
  points.forEach((pt, j) => {
    if (j === 0) { cur = { pts: [pt], start: 0 }; return; }
    const d = Math.hypot(pt.x - points[j - 1].x, pt.y - points[j - 1].y);
    if (pt.gap) { runs.push(cur); cur = { pts: [pt], start: acc }; lens.push(acc); return; }
    acc += d; lens.push(acc); cur.pts.push(pt);
  });
  if (cur) runs.push(cur);
  for (const r of runs) {
    r.len = 0;
    for (let j = 1; j < r.pts.length; j++) r.len += Math.hypot(r.pts[j].x - r.pts[j - 1].x, r.pts[j].y - r.pts[j - 1].y);
    r.d = "M" + r.pts.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join("L");
  }
  return { runs: runs.filter((r) => r.pts.length > 1), lens };
}

/**
 * Mounts the band. `ui` holds the page's elements: `svg`, `box` (the band's
 * container), `tip`, `ro1`/`ro2` (the readout), `steps` (the step buttons),
 * `flip` and `restore`. Hooks: `onUser()` after any click on the band's own
 * controls, `onBytes(input, why)` whenever the bytes being checked change
 * (a flipped byte, a restore). Every animation cancels the one before it;
 * each method resolves to false when it was cancelled.
 */
export function createBand(fe, ui, hooks = {}) {
  const { svg, box, tip, ro1, ro2 } = ui;
  const stepBtns = [...ui.steps], ORDER = ["fetch", "check", "read"];
  let R = null, st = null, cur = null, F = null, SC = null, lastW = 0, pending = null;
  let epoch = 0;
  const CANCEL = Symbol("cancel");
  const wait = (ms, ep) => new Promise((res, rej) => setTimeout(() => (ep === epoch ? res() : rej(CANCEL)), REDUCE ? 0 : ms));
  const N = () => R.nodes.length;
  const say = (a, b) => { ro1.innerHTML = a || "&nbsp;"; ro2.innerHTML = b || "&nbsp;"; };

  function phase(name, p) {
    stepBtns.forEach((b) => {
      const on = b.dataset.step === name, before = ORDER.indexOf(b.dataset.step) < ORDER.indexOf(name);
      b.classList.toggle("on", on);
      b.querySelector(".bar i").style.width = on ? `${Math.round(p * 100)}%` : before ? "100%" : "0%";
    });
  }

  function build(G) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${G.W} ${G.H}`);
    svg.setAttribute("height", Math.round((G.H * (G.realW || G.W)) / G.W));
    svg.classList.toggle("mob", G.mobile);
    const S = { G, blk: [], nib: [], hash: [], fields: [], trails: [] };
    const gGhost = el("g", {}, svg), gTrail = el("g", {}, svg), gNodes = el("g", {}, svg), gLab = el("g", {}, svg);
    const { p, bh } = G;

    for (const [k, pts] of [[1, G.seg1], [2, G.seg2]]) {
      if (pts.length < 2) continue;
      const { runs, lens } = runsOf(pts);
      for (const r of runs) el("path", { d: r.d, class: "ghost-trail" }, gGhost);
      const live = runs.map((r) => {
        const e = el("path", { d: r.d, class: "trail" }, gTrail);
        e.style.strokeDasharray = `${r.len} ${r.len}`;
        e.style.strokeDashoffset = r.len;
        return { e, start: r.start, len: r.len };
      });
      S.trails[k] = { live, lens };
    }
    S.brk = el("path", { d: "", class: "brk" }, gTrail);

    const head = (S.head = el("g", { class: "head" }, gNodes));
    el("rect", { x: G.head.x - 4.5, y: G.head.y - 4.5, width: 9, height: 9, class: "head-sq" }, head);
    for (const L of G.headLabels) { const t = txt(gLab, L.x, L.y, L.t, "t-lab"); if (L.s) t.style.fill = "var(--ink-2)"; }

    for (const n of R.nodes) {
      const P = G.pos[n.i];
      const flippable = n.idx >= 0;
      const g = el("g", { class: "blk", tabindex: flippable ? 0 : -1, role: flippable ? "button" : "img", "aria-label": `${nodeName(n)}, ${n.length} bytes, ${n.kind}${flippable ? ". Flip one of its bytes." : ", embedded in its parent."}` }, gNodes);
      g.dataset.i = n.i;
      if (n.kind === "branch") {
        el("rect", { x: P.cx - bh - 4, y: P.cy - bh - 4, width: 2 * bh + 8, height: 2 * bh + 8, rx: 7, class: "badbox" }, g);
        el("rect", { x: P.cx - bh - 4, y: P.cy - bh - 4, width: 2 * bh + 8, height: 2 * bh + 8, rx: 7, class: "focus" }, g);
        for (let s = 0; s < 16; s++) {
          const x = P.cx + ((s % 4) - 1.5) * p, y = P.cy + ((s >> 2) - 1.5) * p;
          if (s === n.want && !n.empty) { el("circle", { cx: x, cy: y, r: p * 0.55, class: "d-halo" }, g); el("circle", { cx: x, cy: y, r: p * 0.26, class: "d-take" }, g); }
          else if (n.occ[s]) el("circle", { cx: x, cy: y, r: p * 0.22, class: "d-occ" }, g);
          else { if (s === n.want) el("circle", { cx: x, cy: y, r: p * 0.5, class: "d-want" }, g); el("circle", { cx: x, cy: y, r: p * 0.17, class: "d-emp" }, g); }
        }
        el("rect", { x: P.cx - bh - 6, y: P.cy - bh - 14, width: 2 * bh + 12, height: 2 * bh + 34, class: "hit" }, g);
        S.nib[n.i] = txt(gLab, P.cx, P.cy - bh - 9, n.want.toString(16), "t-nib", "middle");
      } else {
        const L = n.key.length, step = P.w / Math.max(1, L - 1), x0 = P.cx - (P.dir * P.w) / 2;
        el("rect", { x: P.cx - P.w / 2 - 6, y: P.cy - 9, width: P.w + 12, height: 18, rx: 7, class: "badbox" }, g);
        el("rect", { x: P.cx - P.w / 2 - 6, y: P.cy - 9, width: P.w + 12, height: 18, rx: 7, class: "focus" }, g);
        for (let j = 0; j < L; j++) {
          const cls = "leafdot" + (j === n.split ? " split" : n.split >= 0 && j > n.split ? " other" : "");
          const c = el("circle", { cx: x0 + P.dir * j * step, cy: P.cy, r: G.mobile ? 0.8 : 0.95, class: cls }, g);
          c.style.transitionDelay = `${j * 5}ms`;
        }
        if (n.split >= 0) el("circle", { cx: x0 + P.dir * n.split * step, cy: P.cy, r: 5, class: "d-want" }, g);
        el("rect", { x: P.cx - P.w / 2 - 6, y: P.cy - bh - 14, width: P.w + 12, height: 2 * bh + 34, class: "hit" }, g);
        S.nib[n.i] = txt(gLab, P.cx, P.cy - bh - 9, n.kind === "leaf" ? `leaf · ${L}` : `ext · ${L}`, "t-nib", "middle");
      }
      S.hash[n.i] = txt(gLab, P.cx, P.cy + bh + 15, "", "t-hash", "middle");
      S.blk[n.i] = g;
    }

    for (const B of G.brackets) {
      if (!B.noLine) el("path", { d: `M${B.x1} ${B.y - 4}V${B.y}H${B.x2}V${B.y - 4}`, class: "bracket" }, gLab);
      const t = el("text", { x: B.anchor === "start" ? B.x1 : B.x2, y: B.y + (B.noLine ? 0 : 15), class: "t-lab", "text-anchor": B.anchor }, gLab);
      const nn = B.trie === "state" ? R.state.length : R.storage.length;
      const what = B.trie === "state" ? R.label : R.slotName;
      const s1 = el("tspan", { class: "s" }, t);
      s1.textContent = `${B.trie} trie`;
      t.appendChild(document.createTextNode(`  ·  ${G.mobile && B.trie === "storage" ? "" : what + "  ·  "}${nn} nodes  ·  ${grp(R.bytesOf(B.trie))} B`));
    }

    // the hinge: the account record, or its absence
    const C = G.card, card = (S.card = el("g", { class: "card" + (R.exists ? "" : " absent") }, gNodes));
    el("rect", { x: C.x + 0.5, y: C.y + 0.5, width: C.w - 1, height: C.h - 1, rx: 13, class: "card-r" }, card);
    if (R.exists) {
      const leaf = R.state.at(-1);
      txt(card, C.x + 16, C.y + 23, `Account ${short(R.account)}`, "c-t");
      txt(card, C.x + C.w - 16, C.y + 23, `leaf ${leaf.length} B`, "c-tm", "end");
      el("path", { d: `M${C.x + 16} ${C.y + 34.5}H${C.x + C.w - 16}`, stroke: "rgba(231,239,233,.08)" }, card);
      const c2 = C.x + 16 + Math.min(118, (C.w - 32) * 0.46);
      const cols = [["nonce", String(R.nonce), C.x + 16, 0], ["balance", eth2(R.balance), c2, 0], ["storageRoot", h8(R.storageRoot), C.x + 16, 1], ["codeHash", h8(leaf.codeHash || ""), c2, 1]];
      for (const [k, v, x, row] of cols) {
        txt(card, x, C.y + 52 + row * 33, k, "c-k");
        const t = txt(card, x, C.y + 67 + row * 33, "", "c-v" + (k === "storageRoot" ? " sr" : ""));
        S.fields.push([t, v]);
      }
    } else {
      const w = absenceWhy(R.state.at(-1));
      txt(card, C.x + 16, C.y + 26, `No account at ${short(R.account)}`, "c-t");
      txt(card, C.x + C.w - 16, C.y + 26, "absent", "c-tm", "end");
      el("path", { d: `M${C.x + 16} ${C.y + 37.5}H${C.x + C.w - 16}`, stroke: "rgba(110,231,183,.14)" }, card);
      txt(card, C.x + 16, C.y + 62, w.long, "c-p");
      txt(card, C.x + 16, C.y + 80, w.long2 || "", "c-p");
    }

    if (G.chip && R.exists && R.storage.length) {
      const chip = (S.chip = el("g", { class: "chip" }, gNodes));
      const cw = G.mobile ? 66 : 76;
      el("rect", { x: -cw / 2, y: -10.5, width: cw, height: 21, rx: 10.5 }, chip);
      txt(chip, 0, 3.8, h8(R.storageRoot), "", "middle");
    }
    // no account, or no storage: nothing to walk below, the walk returns straight to the value
    if (!R.exists || !R.storage.length) {
      const sx = G.mobile ? 40 : G.card.x + 48, top = G.card.y + G.card.h;
      const d = G.mobile ? `M${sx} ${top}V${G.anchor.y}H4` : `M${sx} ${top}V${G.yB}H${G.anchor.x}`;
      S.ret = el("path", { d, class: "ret" }, gTrail);
      if (!G.mobile) {
        const why = R.exists ? "no storage trie to walk: its storage root is the empty trie" : "no storage trie to walk: the account does not exist";
        S.retLab = txt(gLab, G.retLabel.x, G.retLabel.y, why, "t-lab ret-lab", "middle");
      }
    }

    const val = (S.val = el("g", { class: "val" }, gNodes));
    txt(val, G.val.x, G.val.label, R.valueLabel, "t-lab");
    const num = el("g", { class: "v-num" }, val);
    S.vBig = txt(num, G.val.x, G.val.base, "", "v-big");
    S.vBig.style.fontSize = G.vf + "px";
    S.vUnit = txt(num, G.val.x, G.val.base, "", "v-unit");
    S.vNotes = G.val.notes.map((y) => txt(num, G.val.x, y, "", "v-note"));

    S.reason = el("g", { class: "reason" }, gLab);
    S.reasonR = el("rect", { x: 0, y: -10, width: 10, height: 19, rx: 9.5 }, S.reason);
    S.reasonT = txt(S.reason, 0, 3.6, "", "", "middle");

    S.runner = el("g", { opacity: 0 }, svg);
    el("circle", { r: 6, class: "runner-halo" }, S.runner);
    el("circle", { r: 2.3, class: "runner" }, S.runner);

    for (const n of R.nodes) {
      const g = S.blk[n.i];
      g.addEventListener("pointerenter", () => showTip(n));
      g.addEventListener("pointerleave", () => tip.classList.remove("on"));
      g.addEventListener("focus", () => showTip(n));
      g.addEventListener("blur", () => tip.classList.remove("on"));
      g.addEventListener("click", () => { tip.classList.remove("on"); if (n.idx >= 0) userFlip(n.i); });
      g.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && n.idx >= 0) { e.preventDefault(); userFlip(n.i); } });
    }
    SC = S;
    apply();
  }

  /* ---------- model → DOM ---------- */
  function fresh() {
    return { arrive: N(), head: false, headBad: false, node: R.nodes.map(() => "ghost"), hash: R.nodes.map(() => null), p1: -1, p2: -1, fields: 0, card: false, chipOn: false, chip: "home", ret: false, value: false, rolling: false, badAt: -1, reason: null, D: describe(R, R.tr.value) };
  }
  function nodeName(n) { return `${n.trie} node ${n.k + 1} of ${n.trie === "state" ? R.state.length : R.storage.length}`; }
  function parentOf(n) { if (n.k === 0) return n.trie === "state" ? null : R.state.at(-1); return R.nodes[n.i - 1]; }
  function parentName(n) {
    if (n.k === 0) return n.trie === "state" ? `the stateRoot of block ${R.blockNo}` : "the account’s storageRoot";
    const P = parentOf(n);
    return P.kind === "branch" ? `slot ${P.want.toString(16)} of ${P.trie} node ${P.k + 1}` : `${P.trie} node ${P.k + 1}`;
  }
  const curBytes = (n) => (n.idx >= 0 ? cur[n.trie][n.idx] : n.bytes);
  function refOf(n) {
    if (n.trie === "state" && n.k === 0) return R.stateRoot;
    const P = parentOf(n);
    if (!P || !P.refAt) return "";
    const pb = curBytes(P);
    return pb ? toHex(pb.subarray(P.refAt.off, P.refAt.off + 32)) : "";
  }
  function firstBreak() {
    for (const n of R.nodes) {
      if (n.inline) continue; // checked as part of its parent's bytes
      if (n.idx >= 0 && !cur[n.trie][n.idx]) return { i: n.i, missing: true };
      const h = keccak(curBytes(n)), ref = refOf(n);
      if (h !== ref) return { i: n.i, h, ref };
    }
    return null;
  }
  function currentInput() {
    return {
      block: cur.block, account: R.account, slot: R.slot,
      accountProof: cur.state.map((b) => "0x" + toHex(b)),
      storageProof: cur.storage.map((b) => "0x" + toHex(b)),
    };
  }
  const verdict = () => verifyRead(fe, currentInput());

  function setTrail(k, idx) {
    const T = SC.trails[k];
    if (!T) return;
    const L = idx < 0 ? -1 : T.lens[Math.min(idx, T.lens.length - 1)];
    for (const r of T.live) { const shown = L < 0 ? 0 : Math.max(0, Math.min(r.len, L - r.start)); r.e.style.strokeDashoffset = r.len - shown; }
  }
  function pill(text, x, y, anchor) {
    const S = SC, G = S.G;
    S.reasonT.textContent = text;
    const w = text.length * 6.5 + 20;
    S.reasonR.setAttribute("x", -w / 2);
    S.reasonR.setAttribute("width", w);
    const cx = anchor === "start" ? x + w / 2 : Math.max(w / 2 + 2, Math.min(G.W - w / 2 - 2, x));
    S.reason.setAttribute("transform", `translate(${cx} ${y})`);
    S.reason.classList.add("on");
  }
  function apply(instantChip) {
    if (!SC || !st) return;
    const S = SC, G = S.G;
    R.nodes.forEach((n, i) => {
      const s = st.node[i];
      S.blk[i].setAttribute("class", "blk " + (i >= st.arrive ? "pre" : s));
      S.nib[i].classList.toggle("on", s === "done");
      const h = st.hash[i], t = S.hash[i];
      t.textContent = h ? h.t : "";
      t.classList.toggle("on", !!h);
      t.classList.toggle("bad", !!(h && h.bad));
    });
    S.head.classList.toggle("ok", st.head);
    S.head.classList.toggle("bad", st.headBad);
    setTrail(1, st.p1);
    setTrail(2, st.p2);
    S.card.classList.toggle("on", st.card);
    S.fields.forEach(([t, v], j) => { t.textContent = j < st.fields ? v : ""; });
    if (S.chip) {
      if (instantChip) S.chip.style.transition = "none";
      const [x, y] = st.chip === "drop" ? [G.chip.x, G.chip.y] : [G.chip.fx, G.chip.fy];
      S.chip.style.transform = `translate(${x}px, ${y}px)`;
      S.chip.classList.toggle("on", st.chipOn);
      if (instantChip) { void S.chip.getBoundingClientRect(); S.chip.style.transition = ""; }
    }
    if (S.ret) { S.ret.classList.toggle("on", st.ret); if (S.retLab) S.retLab.classList.toggle("on", st.ret); }
    S.val.classList.toggle("on", st.value);
    if (st.value && !st.rolling) setValue(st.D);
    S.nib.forEach((t) => t && (t.style.opacity = ""));
    if (st.badAt >= 0) {
      // a broken link: red dashes from the last good point, and the wasm's reason
      const n = R.nodes[st.badAt], P = G.pos[n.i];
      const [k] = G.ptOf[n.i];
      const pts = k === 1 ? G.seg1 : G.seg2;
      const first = pts.findIndex((q) => q.i === n.i), a = pts[first - 1], b = pts[first];
      S.brk.setAttribute("d", a && b ? `M${a.x} ${a.y}L${b.x} ${b.y}` : "");
      S.brk.classList.add("on");
      pill(st.reason, P.cx, P.cy - G.bh - 13);
      S.nib[n.i].style.opacity = 0;
    } else if (st.headBad) {
      S.brk.classList.remove("on");
      pill(st.reason, G.headPill.x, G.headPill.y, G.headPill.anchor);
    } else {
      S.brk.classList.remove("on");
      S.reason.classList.remove("on");
    }
  }

  function setValue(D, partial) {
    const S = SC;
    S.vBig.textContent = partial != null ? partial : D.big;
    S.vUnit.textContent = D.unit;
    S.vUnit.setAttribute("x", S.G.val.x + S.vBig.getComputedTextLength() + 8);
    S.vNotes.forEach((t, j) => (t.textContent = D.notes[j] || ""));
  }
  function rollNum(D, ms) {
    st.rolling = true;
    if (REDUCE || !ms) { st.rolling = false; setValue(D); return Promise.resolve(); }
    const t0 = performance.now(), final = D.big, myEpoch = epoch;
    return new Promise((res) => {
      const iv = setInterval(() => {
        if (myEpoch !== epoch || !SC) { clearInterval(iv); st.rolling = false; res(); return; }
        const k = Math.min(1, (performance.now() - t0) / ms), settled = Math.floor(k * final.length);
        let s = "";
        for (let i = 0; i < final.length; i++) s += i < settled || !/\d/.test(final[i]) ? final[i] : String((Math.random() * 10) | 0);
        setValue(D, s);
        if (k >= 1) { clearInterval(iv); st.rolling = false; setValue(D); res(); }
      }, 40);
    });
  }

  /* the runner: a dot travelling the verified path, leaves included */
  let runRaf = 0;
  function stopRunner() { cancelAnimationFrame(runRaf); if (SC) SC.runner.setAttribute("opacity", 0); }
  function startRunner() {
    stopRunner();
    if (REDUCE || !SC) return;
    const pts = [...SC.G.seg1, ...SC.G.seg2];
    if (pts.length < 2) return;
    const L = [0];
    for (let j = 1; j < pts.length; j++) L.push(L[j - 1] + Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y) * (j === SC.G.seg1.length ? 0 : 1));
    const total = L.at(-1), dur = Math.max(3200, total * 2.2), t0 = performance.now(), R0 = SC.runner;
    R0.setAttribute("opacity", 1);
    (function tick(now) {
      const d = (((now - t0) % dur) / dur) * total;
      let j = 1;
      while (j < L.length - 1 && L[j] < d) j++;
      const a = pts[j - 1], b = pts[j], f = L[j] > L[j - 1] ? (d - L[j - 1]) / (L[j] - L[j - 1]) : 1;
      R0.setAttribute("transform", `translate(${(a.x + (b.x - a.x) * f).toFixed(1)} ${(a.y + (b.y - a.y) * f).toFixed(1)})`);
      runRaf = requestAnimationFrame(tick);
    })(t0);
  }

  function showTip(n) {
    const of = n.trie === "state" ? R.state.length : R.storage.length;
    const bytes = curBytes(n);
    const body = n.kind === "branch"
      ? `${n.occ.filter(Boolean).length} of 16 slots taken · nibble ${n.depth} wants <span class="m">${n.want.toString(16)}</span>${n.empty ? " · <b>empty</b>" : ""}`
      : n.split >= 0 ? `holds another key: <b>${n.key.slice(0, 6)}…</b> vs ours <b>${n.ours.slice(0, 6)}…</b>` : `holds the last ${n.key.length} nibbles of the key`;
    const foot = n.idx >= 0 ? '<span class="m">click to flip one of its bytes</span>' : "embedded in its parent: checked with its parent’s bytes";
    tip.innerHTML = `<b>${n.trie === "state" ? "State" : "Storage"} trie</b> · ${n.kind} ${n.k + 1} of ${of} · ${n.length} B<br>${body}<br>${bytes ? `keccak <b>${keccak(bytes).slice(0, 16)}…</b>` : "<b>missing from this proof</b>"}<br>${foot}`;
    const P = SC.G.pos[n.i], sb = svg.getBoundingClientRect(), bb = box.getBoundingClientRect(), s = sb.width / SC.G.W;
    tip.classList.add("on");
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(bb.width - tw, sb.left - bb.left + P.cx * s - tw / 2)) + "px";
    tip.style.top = sb.top - bb.top + (P.cy + SC.G.bh + 24) * s + "px";
  }

  /* ---------- sequencing ---------- */
  async function fetchStep(ep) {
    phase("fetch", 0);
    stopRunner();
    st = fresh();
    st.arrive = 0;
    apply(true);
    say(`<b>${R.source}</b> · ${R.what} · block ${R.blockNo}`, "&nbsp;");
    for (let i = 1; i <= N(); i++) { st.arrive = i; apply(); phase("fetch", (0.6 * i) / N()); await wait(42, ep); }
    await wait(240, ep);
    const v = cur.block === R.input.block ? null : verdict();
    if (v && v.stage === "header" && !v.ok) {
      // the header itself is refused: nothing under it is looked at
      st.headBad = true; st.reason = v.reason;
      for (let j = 0; j < N(); j++) st.node[j] = "dim";
      apply();
      say(`header ${v.headerBytes} B hashes to <b>${(v.headerHash || "?").slice(0, 10)}…</b>`,
        `<span class="bad">≠ the block hash ${v.blockHash.slice(0, 10)}… · ferrotype.wasm refuses the header (${v.reason}): nothing below it is trusted</span>`);
      phase("fetch", 1);
      return false;
    }
    st.head = R.headerOk;
    apply();
    say(`${N()} nodes, ${grp(R.total)} bytes · header ${R.hdrLen} B hashes to <b>${R.hdr.hash.slice(0, 10)}…</b>`,
      R.headerOk ? `<span class="ok">= the hash of block ${R.blockNo}, read by ferrotype.wasm</span>` : '<span class="bad">≠ the block hash: nothing below can be trusted</span>');
    phase("fetch", 1);
    await wait(800, ep);
    return R.headerOk;
  }

  async function hinge(ep, s) {
    const leaf = R.state.at(-1);
    st.p1 = SC.G.seg1.length - 1; st.card = true; apply();
    await wait(s(260), ep);
    say(`the account · ${short(R.account)} · its record is the leaf, state node ${leaf.k + 1}`,
      `nonce ${R.nonce} · balance ${eth2(R.balance)} · storageRoot <b>${h8(R.storageRoot)}</b> · codeHash ${h8(leaf.codeHash || "")}`);
    for (let f = 1; f <= 4; f++) { st.fields = f; apply(); await wait(s(130), ep); }
    if (!SC.chip) return;
    st.chipOn = true; st.chip = "home"; apply(true);
    await wait(s(280), ep);
    st.chip = "drop"; st.p2 = 1; apply();
    say(`storageRoot <b>${h8(R.storageRoot)}</b> leaves the account`, "and becomes the 32 bytes storage node 1 has to hash to");
    await wait(s(760), ep);
  }

  async function absent(ep, s) {
    const L = R.state.at(-1), v = verdict(), w = absenceWhy(L);
    st.p1 = SC.G.seg1.length - 1; st.card = true; apply();
    say(`${L ? nodeName(L) + " · " : ""}${w.short}`,
      v.ok ? `<span class="ok">so no account can sit under it: ferrotype.wasm returned exists = ${v.exists}</span>` : `<span class="bad">ferrotype.wasm: ${v.reason}</span>`);
    await wait(s(700), ep);
    st.ret = true; apply();
    await wait(s(500), ep);
  }

  async function emptyStorage(ep, s) {
    await hinge(ep, s);
    say(`storageRoot <b>${h8(R.storageRoot)}</b> is the root of the empty trie`, "<span class=\"ok\">so every slot of this account is zero, with no storage proof needed</span>");
    st.ret = true; apply();
    await wait(s(600), ep);
  }

  async function checkStep(ep, speed = 1, brk = null) {
    phase("check", 0);
    for (let i = 0; i < N(); i++) {
      const n = R.nodes[i];
      const f = brk && i < brk.i ? 0.3 : 1, s = (ms) => ms * speed * f;
      if (n.trie === "storage" && n.k === 0) await hinge(ep, s);
      st.node[i] = "lit"; apply();
      if (n.inline) say(`${nodeName(n)} · depth ${n.depth} · ${n.length} B ${n.kind}, embedded in its parent`, "it is shorter than 32 bytes, so its parent holds it whole");
      else say(`${nodeName(n)} · depth ${n.depth} · ${n.length} B ${n.kind} · <b>keccak</b> of every byte`, `must equal the 32 bytes held by ${parentName(n)}`);
      await wait(s(brk && brk.i === i ? 520 : 230), ep);
      if (brk && brk.i === i) {
        st.node[i] = brk.missing ? "bad missing" : "bad"; st.badAt = i; st.reason = F.reason;
        if (brk.missing) st.hash[i] = { t: "missing", bad: true };
        else st.hash[i] = { t: brk.h.slice(0, 8), bad: true };
        for (let j = i + 1; j < N(); j++) st.node[j] = "dim";
        apply();
        if (brk.missing) {
          say(`${nodeName(n)} · <b>not in the proof</b>: ${F.what || "the node list ends here"}`,
            `the path goes on, the nodes stop · <span class="bad">ferrotype.wasm: ${F.reason}</span>`);
        } else {
          say(F.byte != null ? `${nodeName(n)} · byte ${F.byte} flipped <b>${F.from} → ${F.to}</b>` : `${nodeName(n)} · ${F.what || "changed"}`,
            `keccak <span class="bad">${brk.h.slice(0, 8)}</span> ≠ ${(brk.ref || "nothing").slice(0, 8)} held by ${parentName(n)} · <span class="bad">ferrotype.wasm: ${F.reason}</span>`);
        }
        phase("check", (i + 1) / N());
        return false;
      }
      const h = n.inline ? null : keccak(curBytes(n));
      st.node[i] = "done"; st.hash[i] = { t: h ? h.slice(0, 8) : "inline" };
      const [k, j] = SC.G.ptOf[n.i];
      if (k === 1) st.p1 = j; else st.p2 = j;
      apply();
      say(`${nodeName(n)} · depth ${n.depth} · ${n.length} B ${n.kind}`, h ? `<span class="ok">keccak ${h.slice(0, 8)} = the 32 bytes held by ${parentName(n)}</span>` : '<span class="ok">part of its parent’s bytes, which were checked</span>');
      phase("check", (i + 1) / N());
      await wait(s(n.kind === "leaf" ? 420 : 150), ep);
    }
    if (!R.exists) await absent(ep, (ms) => ms * speed);
    else if (!R.storage.length) await emptyStorage(ep, (ms) => ms * speed);
    return true;
  }

  async function readStep(ep) {
    phase("read", 0);
    const v = verdict();
    if (!v.ok) { say("&nbsp;", `<span class="bad">ferrotype.wasm: ${v.reason}</span>`); phase("read", 1); return; }
    st.D = describe(R, v.value);
    if (R.exists && R.storage.length) st.p2 = SC.G.seg2.length - 1;
    st.value = true; st.rolling = true; apply();
    say(`ferrotype.wasm returned <b>${wordShort(v.value)}</b>${R.exists ? "" : " · exists = false"}`, `<span class="ok">${st.D.line}</span>`);
    phase("read", 0.5);
    await rollNum(st.D, /^0$/.test(st.D.big) ? 0 : 560);
    phase("read", 1);
    startRunner();
  }

  /* the bytes being checked */
  function intact() {
    cur = { block: R.input.block, state: R.lists.state.map((b) => b.slice()), storage: R.lists.storage.map((b) => b.slice()) };
    F = null;
    ui.restore.hidden = true;
  }
  function setFlip(i, byte) {
    intact();
    const n = R.nodes[i], a = cur[n.trie][n.idx], from = a[byte];
    a[byte] = from ^ 0xff;
    const v = verdict();
    F = { kind: "flip", i, byte, from: from.toString(16).padStart(2, "0"), to: a[byte].toString(16).padStart(2, "0"), reason: v.ok ? "accepted" : v.reason, v };
    ui.restore.hidden = false;
  }

  async function playDamage(ep, speed) {
    stopRunner();
    if (F.v.stage === "header" && !F.v.ok) { await fetchStep(ep); return; }
    const brk = firstBreak();
    st = fresh(); st.head = R.headerOk; apply(true);
    if (!brk) { await checkStep(ep, speed); await readStep(ep); return; }
    await checkStep(ep, speed, brk);
  }

  /** Switches to the read `show` was given, if it is still fading in. */
  function commit() {
    if (!pending) return;
    R = pending; pending = null;
    intact(); st = fresh();
    layoutNow();
    svg.classList.remove("swap");
  }

  /** Runs `fn(ep)` as the one current animation; resolves false if a later one cancelled it. */
  function task(fn) {
    commit();
    const ep = ++epoch;
    return fn(ep).then(() => ep === epoch, (e) => { if (e === CANCEL) return false; throw e; });
  }

  function layoutNow() {
    const W = Math.floor(box.clientWidth);
    lastW = W;
    // between phone and full desktop the two rows keep their shape and scale down a little
    const G = geom(R, W >= 900 && W < 1160 ? 1160 : W);
    G.realW = W;
    build(G);
  }

  async function userAct(fn) {
    if (hooks.onUser) hooks.onUser();
    return task(fn);
  }
  function userFlip(i) {
    if (pending) return;
    const n = R.nodes[i], len = cur[n.trie][n.idx] ? cur[n.trie][n.idx].length : 0;
    if (!len) return;
    const byte = 1 + Math.floor(Math.random() * (len - 1));
    setFlip(i, byte);
    if (hooks.onBytes) hooks.onBytes(currentInput(), { kind: "flip", node: nodeName(n), byte, from: F.from, to: F.to });
    userAct((ep) => playDamage(ep, 0.55));
  }

  // the band's own controls
  stepBtns.forEach((b) => b.addEventListener("click", () => {
    if (!R) return;
    const s = b.dataset.step;
    userAct(async (ep) => {
      if (F && hooks.keepDamage) { await playDamage(ep, s === "read" ? 0.3 : 0.7); return; }
      if (F) { intact(); if (hooks.onBytes) hooks.onBytes(currentInput(), { kind: "restore" }); }
      if (s === "fetch") { await fetchStep(ep); await checkStep(ep); await readStep(ep); }
      else if (s === "check") { stopRunner(); st = fresh(); st.head = R.headerOk; apply(true); await checkStep(ep, 0.9); await readStep(ep); }
      else {
        if (!st || !st.card) { stopRunner(); st = fresh(); st.head = R.headerOk; apply(true); await checkStep(ep, 0.25); }
        st.value = false;
        if (R.exists && R.storage.length) st.p2 = SC.G.seg2.length - 2;
        stopRunner(); apply();
        await wait(300, ep);
        await readStep(ep);
      }
    });
  }));
  ui.flip.addEventListener("click", () => {
    if (!R) return;
    const pool = R.nodes.filter((n) => n.idx >= 0 && cur[n.trie][n.idx]);
    if (pool.length) userFlip(pool[Math.floor(Math.random() * pool.length)].i);
  });
  ui.restore.addEventListener("click", () => {
    if (!R) return;
    intact();
    if (hooks.onBytes) hooks.onBytes(currentInput(), { kind: "restore" });
    userAct(async (ep) => { await fetchStep(ep); await checkStep(ep, 0.6); await readStep(ep); });
  });

  let rz;
  new ResizeObserver(() => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (Math.floor(box.clientWidth) !== lastW && R) {
        const keep = st;
        layoutNow();
        st = keep;
        apply(true);
        if (st && st.value) startRunner();
      }
    }, 90);
  }).observe(box);

  return {
    get read() { return pending || R; },
    get damaged() { return !!F; },
    currentInput,
    verdict,
    say,
    /** Draws `next` (fading out the read before it); no animation of its own. */
    show(next) {
      const fade = SC && !REDUCE && R !== next;
      const run = task(async (ep) => {
        if (fade) { svg.classList.add("swap"); await wait(380, ep); }
        commit();
      });
      pending = next; // set after task() began, so only a later call commits it early
      if (!fade) commit();
      return run;
    },
    /** Fetch → Check → Read on the bytes as they are now. */
    full(speed = 1) {
      return task(async (ep) => {
        if (F) { await playDamage(ep, speed); return; }
        await fetchStep(ep); await checkStep(ep, speed); await readStep(ep);
      });
    },
    /** Waits, unless something else starts first. */
    pause(ms) { return task((ep) => wait(ms, ep)); },
    /** Flips byte `byte` of node `i` and lets the wasm judge the whole proof. */
    flip(i, byte, speed = 1) { commit(); setFlip(i, byte); return task((ep) => playDamage(ep, speed)); },
    /**
     * Shows a damaged copy of the drawn read: `D = { block, accountProof,
     * storageProof, what }` as saved in a file. Nodes missing from it are
     * drawn as missing.
     */
    damage(D, speed = 0.55) {
      commit();
      cur = { block: D.block, state: D.accountProof.map(fromHex), storage: D.storageProof.map(fromHex) };
      const v = verdict();
      F = { kind: "file", what: D.what, reason: v.ok ? "accepted" : v.reason, v };
      ui.restore.hidden = false;
      return task((ep) => playDamage(ep, speed));
    },
    /** Back to the bytes as fetched, without animating. */
    reset() { commit(); if (R) { intact(); } },
    /** Shows a message instead of a read (nothing drawn is claimed as checked). */
    blank(a, b) { ++epoch; pending = null; stopRunner(); svg.classList.remove("swap"); R = null; SC = null; st = null; svg.innerHTML = ""; svg.removeAttribute("height"); say(a, b); phase("none", 0); },
    cancel() { ++epoch; },
    nodeName: (n) => nodeName(n),
  };
}
