// The landing: three real mainnet reads, re-verified in this tab by
// ferrotype.wasm and replayed on the band, one after another.

import { loadFerrotype } from "./ferrotype.js";
import { buildCase, createBand, el, REDUCE } from "./band.js";
import { grp } from "./bytes.js";

const $ = (id) => document.getElementById(id);
const HOLDER = "0x28c6c06298d514db089934071355e5743bf21d60";

// The saved proofs the native CLI was run on (web/public/runs/*--none.json).
// `demo` is the node and byte the idle loop flips to show a rejection.
const CASES = [
  { file: "usdc--none.json", spec: { kind: "balance", token: "USDC", holder: HOLDER, layout: 2, base: "0x09", dec: 6 }, demo: [12, 300] },
  { file: "weth--none.json", spec: { kind: "balance", token: "WETH", holder: HOLDER, layout: 0, base: "0x03", dec: 18 }, demo: [2, 77] },
  { file: "absent-account--none.json", spec: { kind: "slot" }, demo: [5, 200] },
];

function inputOf(fe, fx, spec) {
  let slot, storageProof;
  if (spec.kind === "balance") {
    slot = fe.balanceSlot(spec.layout, spec.base, spec.holder);
    storageProof = fx.proof.storageProof.find((s) => BigInt(s.key) === BigInt(slot)).proof;
  } else {
    slot = fx.proof.storageProof[0].key;
    storageProof = fx.proof.storageProof[0].proof;
  }
  return { block: fx.block, account: fx.proof.address, slot, accountProof: fx.proof.accountProof, storageProof };
}

/* small static glyphs for "How it works", in the band's own language, from the USDC read */
function glyphs(c) {
  const blockAt = (g, cx, cy, n, done, pp = 6.2) => {
    for (let s = 0; s < 16; s++) {
      const x = cx + ((s % 4) - 1.5) * pp, y = cy + ((s >> 2) - 1.5) * pp;
      if (s === n.want && done) el("circle", { cx: x, cy: y, r: 2.6, fill: "#6ee7b7" }, g);
      else if (n.occ[s]) el("circle", { cx: x, cy: y, r: 1.4, fill: "#7d968a", "fill-opacity": done ? 0.55 : 0.35 }, g);
      else el("circle", { cx: x, cy: y, r: 1.1, fill: "none", stroke: "#46604f", "stroke-width": 0.8 }, g);
    }
  };
  const st0 = c.state;
  const gf = $("g-fetch");
  [0, 1, 2].forEach((j) => blockAt(gf, 54 + j * 46, 29, st0[j], false));
  const gc = $("g-check");
  const take = (cx, n) => [cx + ((n.want % 4) - 1.5) * 6.2, 29 + ((n.want >> 2) - 1.5) * 6.2];
  const [ax, ay] = take(30, st0[0]), [bx, by] = take(100, st0[1]);
  el("path", { d: `M${ax} ${ay}L${bx} ${by}`, stroke: "#6ee7b7", "stroke-width": 1.1, fill: "none" }, gc);
  blockAt(gc, 30, 29, st0[0], true);
  blockAt(gc, 100, 29, st0[1], true);
  const t = el("text", { x: 150, y: 33, fill: "#9af0cd", "font-family": "JetBrains Mono", "font-size": 10.5, "text-anchor": "middle" }, gc);
  t.textContent = "= ref";
  const gr = $("g-read"), leaf = c.storage.at(-1);
  for (let j = 0; j < leaf.key.length; j++) el("circle", { cx: 4 + j * 1.9, cy: 29, r: 0.9, fill: "#2f9c74" }, gr);
  const ex = 4 + (leaf.key.length - 1) * 1.9;
  el("path", { d: `M${ex + 6} 29H${ex + 22}`, stroke: "#6ee7b7", "stroke-width": 1.1 }, gr);
  el("circle", { cx: ex + 28, cy: 29, r: 4, fill: "#6ee7b7" }, gr);
}

let band = null, cases = [], current = 0, loopId = 0, idleT = null;
const tabs = [...document.querySelectorAll(".reads button")];
function select(c) { tabs.forEach((b, j) => { b.setAttribute("aria-selected", String(j === c)); b.tabIndex = j === c ? 0 : -1; }); }

async function loop(start) {
  const id = ++loopId;
  clearTimeout(idleT);
  let c = start;
  for (;;) {
    select(c);
    current = c;
    if (!(await band.show(cases[c])) || id !== loopId) return;
    if (!(await band.full()) || id !== loopId) return;
    if (REDUCE) return;
    if (!(await band.pause(3600)) || id !== loopId) return;
    const [i, b] = cases[c].demo;
    if (!(await band.flip(i, b, 1)) || id !== loopId) return;
    if (!(await band.pause(4400)) || id !== loopId) return;
    c = (c + 1) % cases.length;
  }
}
function idle() {
  ++loopId;
  clearTimeout(idleT);
  if (!REDUCE) idleT = setTimeout(() => loop(current), 16000);
}

tabs.forEach((b, j) => {
  b.addEventListener("click", () => { if (cases.length) loop(j); });
  b.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const k = (j + d + tabs.length) % tabs.length;
    tabs[k].focus();
    if (cases.length) loop(k);
  });
});

(async () => {
  try {
    const [wasm, manifest, ...fxs] = await Promise.all([
      fetch("/public/ferrotype.wasm").then((r) => { if (!r.ok) throw new Error("ferrotype.wasm: HTTP " + r.status); return r.arrayBuffer(); }),
      fetch("/public/ferrotype.manifest.json").then((r) => r.json()),
      ...CASES.map((s) => fetch(`/public/runs/${s.file}`).then((r) => { if (!r.ok) throw new Error(s.file + ": HTTP " + r.status); return r.json(); })),
    ]);
    const fe = await loadFerrotype(wasm);
    const t0 = performance.now();
    cases = CASES.map((c, i) => Object.assign(buildCase(fe, inputOf(fe, fxs[i], c.spec), c.spec), { demo: c.demo }));
    const ms = performance.now() - t0;
    $("stamp").textContent = `ferrotype.wasm · ${grp(wasm.byteLength)} bytes · ${manifest.compiler} · ${cases.length} mainnet reads re-verified in this tab in ${ms.toFixed(0)} ms${cases.every((c) => c.headerOk) ? " · every header hashes to its block hash" : ""}`;
    if (document.fonts) {
      await Promise.race([
        Promise.all([document.fonts.ready, document.fonts.load('500 48px Gambetta'), document.fonts.load("400 15px Switzer"), document.fonts.load('400 11px "JetBrains Mono"')]),
        new Promise((r) => setTimeout(r, 1500)),
      ]).catch(() => {});
    }
    glyphs(cases[0]);
    band = createBand(fe, {
      svg: $("u"), box: $("band"), tip: $("tip"), ro1: $("ro1"), ro2: $("ro2"),
      steps: document.querySelectorAll(".steps button"), flip: $("flip"), restore: $("restore"),
    }, { onUser: idle });
    loop(0);
  } catch (e) {
    console.error(e);
    $("ro1").textContent = "The verifier did not load in this browser, so nothing here is shown as checked.";
  }
})();

const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((n) => io.observe(n));
