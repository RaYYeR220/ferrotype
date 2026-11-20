// The app (/try/): one storage read checked three ways, and the Plebiscite
// contracts on Sepolia asked live.
//
// Lanes: the browser (ferrotype.wasm, run now), the contract (eth_call to the
// deployed StateReader, made now) and the native CLI (its recorded run on
// the same saved file, or nothing when there is none). Every live value comes
// from a call made now; every recorded one names its file. A failed call
// shows its error and a retry, never a stand-in value.

import { loadFerrotype, ProofRejected } from "./ferrotype.js";
import { buildCase, createBand, verifyRead, describe } from "./band.js";
import * as chain from "./chain.js";
import { grp, short, strip, h8, units, wordShort } from "./bytes.js";

const $ = (id) => document.getElementById(id);
const HOLDER = "0x28c6c06298d514db089934071355e5743bf21d60";
const SEPOLIA = [chain.NETWORKS.sepolia.rpc, chain.NETWORKS.sepolia.fallback];
const SCAN = chain.NETWORKS.sepolia.explorer;
const host = (url) => { try { return new URL(url).host; } catch { return url; } };
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const ms = (t) => `${t < 10 ? t.toFixed(1) : Math.round(t)} ms`;

/** A small element builder: strings become text nodes, never HTML. */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const line = (k, ...v) => h("div", null, h("span", { class: "k" }, k), h("span", { class: "v" }, ...v));

// ---- the saved reads ------------------------------------------------------------

const PRESETS = {
  usdc: { spec: { kind: "balance", token: "USDC", holder: HOLDER, layout: 2, base: "0x09", dec: 6 } },
  weth: { spec: { kind: "balance", token: "WETH", holder: HOLDER, layout: 0, base: "0x03", dec: 18 } },
  "absent-account": { spec: { kind: "slot" } },
  "eoa-empty-storage": { spec: { kind: "slot" } },
};
const DAMAGES = ["flip-storage", "truncate-storage", "flip-account", "truncate-account", "wrong-root"];
const LAYOUTS = ["solidity", "vyper", "flagged"];

// Tokens the page can word a balance for. Formatting only: the balance itself
// is always the proven slot.
const TOKENS = {
  mainnet: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { token: "USDC", dec: 6, layout: 2, base: 9, holder: HOLDER },
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { token: "WETH", dec: 18, layout: 0, base: 3, holder: HOLDER },
  },
  sepolia: {},
};

let fe, manifest, index, dep, snaps, band;
let base = null; // the read as fetched or saved: { kind, input, R, spec, ... }
let shown = null; // what the lanes last ran on: { input, ctx }
const files = new Map();

async function sha256(buf) {
  if (!crypto.subtle) return null;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A saved file, its bytes hashed here (so the page can show it is the one the CLI ran on). */
async function loadRun(file) {
  if (files.has(file)) return files.get(file);
  const r = await fetch(`/public/runs/${file}`);
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const v = { json: JSON.parse(new TextDecoder().decode(buf)), sha: await sha256(buf), bytes: buf.byteLength };
  files.set(file, v);
  return v;
}

function inputFrom(fx, account, slot) {
  const sp = fx.proof.storageProof.find((s) => BigInt(s.key) === BigInt(slot));
  return { block: fx.block, account, slot: word(slot), accountProof: fx.proof.accountProof, storageProof: sp ? sp.proof : [] };
}
const recordOf = (fixture, damage) => index.runs.find((r) => r.fixture === fixture && r.damage === damage);

// ---- the picker -------------------------------------------------------------------

const presetBtns = [...document.querySelectorAll(".presets button")];
function markPreset(f) { presetBtns.forEach((b) => { const on = b.dataset.fixture === f; b.setAttribute("aria-checked", String(on)); b.tabIndex = on || (!f && b === presetBtns[0]) ? 0 : -1; }); }

function damageRow(fixture, pressed) {
  const box = $("damage-b");
  box.textContent = "";
  $("damage-k").hidden = !fixture;
  $("damage-n").textContent = fixture ? "or click any node above to flip one of its bytes" : "Click any node above to flip one of its bytes";
  if (!fixture) return;
  for (const d of DAMAGES) {
    const rec = recordOf(fixture, d);
    if (!rec) continue;
    box.append(h("button", { type: "button", "aria-pressed": String(d === pressed), title: rec.what, onclick: () => (d === pressed ? $("restore").click() : pickDamage(d)) }, d));
  }
}

async function pickPreset(f) {
  markPreset(f);
  damageRow(f, null);
  const file = `${f}--none.json`;
  const { json: fx } = await loadRun(file);
  const P = PRESETS[f];
  const slot = P.spec.kind === "balance" ? fe.balanceSlot(P.spec.layout, P.spec.base, P.spec.holder) : fx.proof.storageProof[0].key;
  const input = inputFrom(fx, fx.proof.address.toLowerCase(), slot);
  const R = buildCase(fe, input, P.spec, `saved eth_getProof · runs/${file}`);
  base = { kind: "saved", fixture: f, file, fx, input, R, spec: P.spec };
  band.show(R).then((ok) => ok && band.full());
  runLanes(input, { kind: "saved", fixture: f, damage: "none", file, fx });
}

async function pickDamage(d) {
  if (!base || base.kind !== "saved") return;
  const file = `${base.fixture}--${d}.json`;
  const rec = recordOf(base.fixture, d);
  const { json: dfx } = await loadRun(file);
  const input = inputFrom(dfx, base.input.account, base.input.slot);
  damageRow(base.fixture, d);
  band.damage({ block: dfx.block, accountProof: input.accountProof, storageProof: input.storageProof, what: rec ? rec.what : d });
  runLanes(input, { kind: "saved", fixture: base.fixture, damage: d, file, fx: dfx });
}

/** The band changed the bytes itself: a flipped byte, or a restore. */
function onBytes(input, why) {
  if (!base) return;
  if (why.kind === "restore") {
    if (base.kind === "saved") { damageRow(base.fixture, null); runLanes(base.input, { kind: "saved", fixture: base.fixture, damage: "none", file: base.file, fx: base.fx }); }
    else runLanes(base.input, { kind: "live" });
    return;
  }
  if (base.kind === "saved") damageRow(base.fixture, null);
  runLanes(input, { kind: "flip", why });
}

// ---- live reads -----------------------------------------------------------------------

const form = $("panel-live");
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
function parseNum(s) {
  s = String(s).trim();
  if (/^0x[0-9a-fA-F]{1,64}$/.test(s)) return BigInt(s);
  if (/^\d{1,78}$/.test(s)) { const v = BigInt(s); return v < 1n << 256n ? v : null; }
  return null;
}
const what = () => form.querySelector('input[name="what"]:checked').value;
const blk = () => form.querySelector('input[name="blk"]:checked').value;

function knownToken(net, addr) { return (TOKENS[net] || {})[String(addr).toLowerCase()]; }
function noteContract() {
  const t = knownToken($("net").value, $("contract").value.trim());
  $("contract-note").textContent = t ? `${t.token} · balances at slot ${t.base}, ${LAYOUTS[t.layout]} layout` : "any contract or account";
}
function onContract() {
  const t = knownToken($("net").value, $("contract").value.trim());
  if (t) { $("layout").value = String(t.layout); $("base").value = String(t.base); }
  noteContract();
}
function onNet() {
  const net = $("net").value;
  $("f-rpc").hidden = net !== "custom";
  // swap the example token when it still shows the other network's
  const c = $("contract").value.trim().toLowerCase();
  const other = net === "mainnet" ? TOKENS.sepolia : net === "sepolia" ? TOKENS.mainnet : {};
  if (other[c]) {
    const mine = Object.entries(TOKENS[net])[0];
    if (mine) { $("contract").value = mine[0]; $("holder").value = mine[1].holder; onContract(); }
  }
  noteContract();
}
function syncForm() {
  $("row-balance").hidden = what() !== "balance";
  $("row-slot").hidden = what() !== "slot";
  $("blockno").disabled = blk() !== "number";
}

function liveStatus(text, bad, retry) {
  const s = $("live-status");
  s.textContent = text;
  s.classList.toggle("bad", !!bad);
  if (retry) s.append(h("button", { type: "button", onclick: retry }, "Retry"));
}

async function liveRead(e) {
  if (e) e.preventDefault();
  const net = $("net").value;
  const url = net === "custom" ? $("rpc").value.trim() : chain.NETWORKS[net].rpc;
  const fields = [];
  const bad = (id, ok) => { $(id).setAttribute("aria-invalid", String(!ok)); if (!ok) fields.push(id); };
  bad("rpc", net !== "custom" || /^https?:\/\/\S+$/.test(url));
  const account = $("contract").value.trim();
  bad("contract", isAddr(account));
  let slot = null, spec;
  if (what() === "balance") {
    const holder = $("holder").value.trim(), b = parseNum($("base").value);
    bad("holder", isAddr(holder));
    bad("base", b !== null);
    if (isAddr(holder) && b !== null) {
      const layout = Number($("layout").value);
      try { slot = fe.balanceSlot(layout, word(b), holder.toLowerCase()); }
      catch (err) { liveStatus(`ferrotype.wasm could not place this balance: ${err.message}`, true); return; }
      const t = knownToken(net, account);
      spec = { kind: "balance", token: t ? t.token : "", holder: holder.toLowerCase(), layout, base: word(b), dec: t ? t.dec : 0, layoutName: LAYOUTS[layout], baseText: b.toString() };
    }
  } else {
    const s = parseNum($("slot").value);
    bad("slot", s !== null);
    if (s !== null) { slot = word(s); spec = { kind: "slot" }; }
  }
  let block = "latest";
  if (blk() === "number") { const n = parseNum($("blockno").value); bad("blockno", n !== null); block = n; }
  if (fields.length) { liveStatus("Check the highlighted fields.", true); $(fields[0]).focus(); return; }

  const go = $("go");
  go.disabled = true;
  liveStatus(`Asking ${host(url)} for block ${block === "latest" ? "latest" : grp(block)} and eth_getProof…`);
  const t0 = performance.now();
  try {
    const chainId = net === "custom" ? Number(await chain.rpc(url, "eth_chainId", [])) : chain.NETWORKS[net].chainId;
    const r = await chain.fetchRead(url, { account: account.toLowerCase(), slot, block: block === "latest" ? "latest" : block });
    const input = { block: r.block, account: account.toLowerCase(), slot: r.slot, accountProof: r.accountProof, storageProof: r.storageProof };
    liveStatus(`block ${grp(BigInt(r.block.number))} · ${r.accountProof.length + r.storageProof.length} nodes from ${host(url)} in ${ms(performance.now() - t0)}`);
    let R = null, refused = null;
    try { R = buildCase(fe, input, spec, `eth_getProof · ${host(url)}`); }
    catch (err) { if (err instanceof ProofRejected) refused = err.reason; else throw err; }
    const n = BigInt(r.block.number);
    const cli = spec.kind === "balance"
      ? `ferrotype balance --rpc ${url} --token ${account} --holder ${spec.holder} --layout ${spec.layoutName} --slot ${spec.baseText} --block ${n}`
      : `ferrotype read --rpc ${url} --account ${account} --slot 0x${BigInt(r.slot).toString(16)} --block ${n}`;
    base = { kind: "live", input, R, spec, url, chainId, raw: { chainId: "0x" + chainId.toString(16), block: r.block, proof: r.proof }, cli };
    markPreset(null);
    damageRow(null);
    if (R) band.show(R).then((ok) => ok && band.full());
    else band.blank(`ferrotype.wasm refused what ${host(url)} sent (${refused}), so there are no verified steps to draw.`, "The lanes below show each verifier’s answer.");
    runLanes(input, { kind: "live" });
  } catch (err) {
    const hint = /eth_getProof/.test(err.message) && block !== "latest" && net !== "custom"
      ? " Free public nodes answer eth_getProof only for about the last 100 blocks; for an older block, choose Custom RPC and paste an archive node’s URL."
      : "";
    liveStatus(`${host(url)}: ${err.message}.${hint}`, true, () => liveRead());
  } finally {
    go.disabled = false;
  }
}

// ---- the three lanes -------------------------------------------------------------------

let laneEpoch = 0, evmArgs = null;
const urls = [];

function fill(id, state, ...kids) {
  const lane = $(id), body = lane.querySelector(".lane-body");
  lane.classList.toggle("ok", state === "ok");
  lane.classList.toggle("no", state === "no");
  body.textContent = "";
  body.append(...kids.flat().filter(Boolean));
}

function valueOut(value, label) {
  const R = base && base.R;
  if (!R) return h("div", { class: "out" }, h("div", { class: "out-k" }, label), h("div", { class: "out-v" }, wordShort(value)), h("div", { class: "out-w" }, value));
  const D = describe(R, value);
  return h("div", { class: "out" },
    h("div", { class: "out-k" }, label),
    h("div", { class: "out-v" }, D.big, D.unit ? h("small", null, D.unit) : null),
    h("div", { class: "out-w" }, wordShort(value), D.notes[1] ? ` · ${D.notes[1]}` : ""));
}
function reasonOut(label, reason, detail) {
  return h("div", { class: "out" }, h("div", { class: "out-k" }, label), h("span", { class: "reason-chip" }, reason), detail ? h("div", { class: "out-w" }, detail) : null);
}

function laneWasm(w, input) {
  const nodes = input.accountProof.length + input.storageProof.length;
  const bytes = [...input.accountProof, ...input.storageProof].reduce((a, n) => a + strip(n).length / 2, 0);
  const hdr = w.stage === "header" && !w.ok
    ? [line("header", `${w.headerBytes} B · keccak ${short(w.headerHash || "?")}`), line("", h("span", { class: "bad" }, `≠ block hash ${short(w.blockHash)}`))]
    : [line("header", `${w.headerBytes} B · keccak ${short(w.headerHash)}`), line("", h("span", { class: "ok" }, "= the block hash"))];
  const proof = w.stage === "header" && !w.ok ? line("proof", "not read: the header is refused first") : line("proof", `${nodes} nodes · ${grp(bytes)} B`);
  fill("lane-wasm", w.ok ? "ok" : "no",
    w.ok ? valueOut(w.value, "ferrotype.wasm returned") : reasonOut("ferrotype.wasm refused", w.reason, w.stage === "header" ? "the header does not hash to the block hash" : null),
    h("div", { class: "lines" }, hdr, proof, line("ran", `in ${ms(w.ms)}`)),
    h("div", { class: "meta" }, `ferrotype.wasm · ${grp(manifest.module.size)} B · ${manifest.compiler}`));
  return w.ok ? { ran: true, accepted: true, value: w.value } : { ran: true, accepted: false, reason: w.reason };
}

function laneEvmPending() {
  fill("lane-evm", null, h("div", { class: "out" }, h("div", { class: "out-k" }, "asking the contract…"), h("div", { class: "out-v pending" }, "…")), h("div", { class: "lines" },
    line("call", "storageAtPacked(stateRoot, account, slot, accountProof, storageProof)"),
    line("to", h("a", { class: "ext", href: `${SCAN}/address/${dep.contracts.StateReader}` }, `StateReader ${short(dep.contracts.StateReader)}`)),
    line("via", `${host(SEPOLIA[0])} …`)));
}

async function laneEvm(input, ep) {
  laneEvmPending();
  const data = chain.storageAtPackedCall({ stateRoot: input.block.stateRoot, account: input.account, slot: input.slot, accountProof: input.accountProof, storageProof: input.storageProof });
  const c = await chain.viewAny(SEPOLIA, dep.contracts.StateReader, data);
  if (ep !== laneEpoch) return null;
  const head = h("div", { class: "lines" },
    line("call", "storageAtPacked(stateRoot, account, slot, accountProof, storageProof)"),
    line("to", h("a", { class: "ext", href: `${SCAN}/address/${dep.contracts.StateReader}` }, `StateReader ${short(dep.contracts.StateReader)}`), " on Sepolia"),
    line("root", `${short(strip(input.block.stateRoot).replace(/^/, "0x"))}, passed in`),
    line("via", `${host(c.url)} · eth_call · ${ms(c.ms)}`));
  if (c.ok) {
    fill("lane-evm", "ok", valueOut(c.words[0], "the contract returned"), head, h("div", { class: "meta" }, "It never sees the header: it trusts the state root it is given and proves the rest."));
    return { ran: true, accepted: true, value: c.words[0] };
  }
  if (c.revert) {
    fill("lane-evm", "no", reasonOut("the contract reverted", c.revert.reason, `${c.revert.error}(${c.revert.reason})`), head, h("div", { class: "meta" }, "decoded from the revert data the node returned"));
    return { ran: true, accepted: false, reason: c.revert.reason };
  }
  fill("lane-evm", null, h("div", { class: "out" }, h("div", { class: "out-k" }, "no answer"), h("div", { class: "err" }, c.message)), head,
    h("button", { type: "button", class: "btn-line", onclick: () => retryEvm() }, "Retry"));
  return { ran: false };
}

function proofFile(input, ctx) {
  const src = base.kind === "saved" ? base.fx : base.raw;
  const proof = JSON.parse(JSON.stringify(src.proof));
  proof.accountProof = input.accountProof;
  const sp = proof.storageProof.find((s) => BigInt(s.key) === BigInt(input.slot));
  if (sp) sp.proof = input.storageProof;
  const block = { ...input.block };
  delete block.transactions;
  return { chainId: src.chainId, block, proof };
}

function laneCli(input, ctx) {
  const rec = ctx.kind === "saved" ? recordOf(ctx.fixture, ctx.damage) : null;
  if (rec) {
    const f = files.get(rec.file);
    const match = f && f.sha ? (f.sha === rec.sha256 ? h("span", { class: "ok" }, "= the file this page loaded, hashed here") : h("span", { class: "bad" }, `≠ this page’s copy (${short(f.sha)})`)) : "";
    const term = h("pre", { class: "term" }, h("span", { class: "p" }, `$ ${rec.command}\n`), rec.output.map((l) => (/^error/.test(l) ? h("span", { class: "e" }, l + "\n") : l + "\n")), h("span", { class: rec.exit ? "e" : "p" }, `exit ${rec.exit}`));
    const dl = h("a", { class: "btn-line", href: `/public/runs/${rec.file}`, download: rec.file }, "Download this file");
    let out, verdict;
    if (rec.exit === 0) {
      const m = rec.output.map((l) => l.match(/^slot\s+(0x[0-9a-f]{64}) = (0x[0-9a-f]{64}) proven/i)).find((m) => m && BigInt(m[1]) === BigInt(input.slot));
      verdict = m ? { ran: true, accepted: true, value: m[2] } : { ran: false };
      out = m ? valueOut(m[2], "the CLI printed") : h("div", { class: "out" }, h("div", { class: "out-k" }, "the CLI accepted the file, but printed no line for this slot"));
    } else {
      const reason = rec.reason || (rec.output.some((l) => /header hashes to/.test(l)) ? "header refused" : "refused");
      verdict = { ran: true, accepted: false, reason };
      out = reasonOut(`the CLI refused · exit ${rec.exit}`, reason, rec.reason ? null : "it stops at the header, before any proof");
    }
    fill("lane-cli", verdict.ran ? (verdict.accepted ? "ok" : "no") : null,
      out, term,
      h("div", { class: "lines" }, line("file", rec.file, ` · ${rec.what}`), line("sha256", short(rec.sha256), " ", match)),
      dl,
      h("div", { class: "meta" }, `recorded with ${index.fe}${index.cli_sha256 ? ` · CLI binary sha256 ${index.cli_sha256.slice(0, 12)}…` : ""}`));
    return verdict;
  }
  // nothing recorded for these bytes: hand over the file and the command instead
  const data = proofFile(input, ctx);
  const name = `ferrotype-${BigInt(data.block.number)}-${input.account.slice(2, 8)}${ctx.kind === "flip" ? "-flipped" : ""}.json`;
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1) + "\n"], { type: "application/json" }));
  urls.push(href);
  const why = ctx.kind === "flip" ? `a byte you flipped (${ctx.why.node}, byte ${ctx.why.byte}: ${ctx.why.from} → ${ctx.why.to})` : "a live read";
  fill("lane-cli", null,
    h("div", { class: "out" }, h("div", { class: "out-k" }, "Not recorded for this input"), h("div", { class: "out-w" }, `The CLI was run on the saved files and their named damages, not on ${why}. Run it yourself:`)),
    h("a", { class: "btn-line", href, download: name }, "Download this proof as JSON"),
    h("div", { class: "cmd" }, `ferrotype verify ${name}`),
    base.kind === "live" ? h("div", { class: "cmd" }, base.cli) : null,
    h("div", { class: "meta" }, base.kind === "live" ? "the second command fetches the same block again; free nodes keep it for about 100 blocks" : "the same { block, proof } file the CLI’s verify reads"));
  return { ran: false };
}

function seal(res, ctx) {
  const lanes = [["browser", res.wasm], ["contract", res.evm], ["CLI", res.cli]].filter(([, v]) => v && v.ran);
  const el = $("seal"), why = $("why");
  el.className = "seal";
  why.hidden = true;
  const vs = lanes.map(([, v]) => v);
  const n = vs.length;
  if (!res.evm) { el.classList.add("wait"); $("seal-t").textContent = "Waiting for Sepolia"; $("seal-v").textContent = ""; return; }
  if (vs.every((v) => v.accepted) && vs.every((v) => BigInt(v.value) === BigInt(vs[0].value))) {
    const D = base.R ? describe(base.R, vs[0].value) : null;
    el.classList.add("agree");
    $("seal-t").textContent = n > 1 ? `Same answer ×${n}` : "Checked in this tab";
    $("seal-v").textContent = D ? `${D.big}${D.unit ? " " + D.unit : ""}${D.notes[1] && /flag/.test(D.notes[1]) ? " · " + D.notes[1] : ""}` : wordShort(vs[0].value);
  } else if (vs.every((v) => !v.accepted)) {
    el.classList.add("agree", "refused");
    $("seal-t").textContent = n > 1 ? `Same answer ×${n}: refused` : "Refused in this tab";
    const rs = lanes.map(([k, v]) => `${k} ${v.reason}`);
    $("seal-v").textContent = vs.every((v) => v.reason === vs[0].reason) ? `${vs[0].reason}${n > 1 ? " ×" + n : ""}` : rs.join(" · ");
    if (!vs.every((v) => v.reason === vs[0].reason)) {
      why.hidden = false;
      why.textContent = "";
      if (ctx.damage === "wrong-root") {
        why.append(h("b", null, "Same verdict, different reasons, as they should be. "), "The browser and the CLI rebuild the header and refuse it before reading any proof. The contract never sees a header: it takes the state root as an argument, so it refuses the proof against that root, at the first node.");
      } else {
        why.append(h("b", null, "Same verdict, different reasons. "), "Each lane names the first check that failed for it.");
      }
    }
  } else {
    el.classList.add("split");
    $("seal-t").textContent = "The lanes disagree";
    $("seal-v").textContent = lanes.map(([k, v]) => `${k}: ${v.accepted ? wordShort(v.value) : v.reason}`).join(" · ");
    why.hidden = false;
    why.textContent = "This should never happen: the three lanes run the same Fe verifier on the same bytes. Please report it with the downloaded file.";
    console.error("lanes disagree", res);
  }
  el.dataset.lanes = String(n);
}

async function runLanes(input, ctx) {
  const ep = ++laneEpoch;
  shown = { input, ctx };
  const res = { wasm: null, evm: null, cli: null };
  res.wasm = laneWasm(verifyRead(fe, input), input);
  res.cli = laneCli(input, ctx);
  seal(res, ctx);
  evmArgs = { input, ctx, res, ep };
  const evm = await laneEvm(input, ep);
  if (ep !== laneEpoch) return;
  res.evm = evm;
  seal(res, ctx);
}
async function retryEvm() {
  if (!evmArgs) return;
  const { input, ctx, res } = evmArgs;
  const ep = ++laneEpoch;
  evmArgs.ep = ep;
  res.evm = null;
  seal(res, ctx);
  const evm = await laneEvm(input, ep);
  if (ep !== laneEpoch) return;
  res.evm = evm;
  seal(res, ctx);
}

// ---- Plebiscite -----------------------------------------------------------------------

const DAOS = {};
const PERIOD = (s) => (s % 86400 === 0 ? `${s / 86400} days` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

function daoNames(d) {
  return d.proofs.map((p, i) => {
    const who = Object.entries(dep.voters || {}).find(([, a]) => a.toLowerCase() === p.holder.toLowerCase());
    return d.key === "demo" && who ? who[0][0].toUpperCase() + who[0].slice(1) : `holder ${i + 1}`;
  });
}

function amount(d, raw) { return units(BigInt(raw), d.dec); }

async function loadDao(key) {
  const d = DAOS[key], kv = $(`dao-${key}`), st = $(`dao-${key}-s`);
  st.className = "dao-s";
  st.textContent = `config(), snapshot(${d.proposal}), tally(${d.proposal}): asking ${host(SEPOLIA[0])}…`;
  const t0 = performance.now();
  const [cfg, sn, ta] = await Promise.all([
    chain.viewAny(SEPOLIA, d.dao, chain.CONFIG_CALL),
    chain.viewAny(SEPOLIA, d.dao, chain.snapshotCall(d.proposal)),
    chain.viewAny(SEPOLIA, d.dao, chain.tallyCall(d.proposal)),
  ]);
  const failed = [cfg, sn, ta].find((r) => !r.ok);
  if (failed) {
    st.className = "dao-s bad";
    st.textContent = `${host(failed.url)}: ${failed.revert ? `${failed.revert.error}(${failed.revert.reason})` : failed.message}`;
    st.append(h("button", { type: "button", onclick: () => loadDao(key) }, "Retry"));
    return;
  }
  const W = (r, i) => BigInt(r.words[i]);
  const token = "0x" + strip(cfg.words[0]).slice(24);
  const deadline = Number(W(ta, 3));
  const open = deadline * 1000 > Date.now();
  const at = (t) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const when = at(deadline);
  // Execution opens `timelock` after the deadline and closes `grace` after that
  // (a Plebiscite from before the timelock answers config() with 7 words).
  const timed = cfg.words.length >= 10;
  const from = deadline + (timed ? Number(W(cfg, 8)) : 0), until = timed ? from + Number(W(cfg, 9)) : Infinity;
  const executed = W(ta, 5) === 1n;
  const now = Date.now() / 1000;
  const execution = executed ? "executed" : now < from ? `from ${at(from)}` : now < until ? `open until ${at(until)}` : "expired";
  const row = (k, v, cls) => h("div", null, h("dt", null, k), h("dd", { class: cls || null }, v));
  kv.textContent = "";
  kv.append(...[
    row("votes for", [amount(d, ta.words[0]), h("small", null, d.unit)], "big"),
    row("against", [amount(d, ta.words[1]), h("small", null, d.unit)], "big"),
    row("token", h("a", { href: `${SCAN}/address/${token}` }, short(token))),
    row("balances", `slot ${W(cfg, 2)} · ${LAYOUTS[Number(W(cfg, 1))] || "layout " + W(cfg, 1)}`),
    row("snapshot block", grp(W(sn, 0))),
    row("storage root then", `${h8(sn.words[1])}…`),
    row("supply then", [amount(d, sn.words[2]), h("small", null, d.unit)]),
    row("quorum", `${Number(W(cfg, 5)) / 100}% of supply`),
    timed ? row("to propose", Number(W(cfg, 7)) === 0 ? "any holder" : `${Number(W(cfg, 7)) / 100}% of supply`) : null,
    row("snapshot", `at most ${W(cfg, 6)} blocks old`),
    row("voting", `${PERIOD(Number(W(cfg, 4)))} · ${open ? "open until" : "closed"} ${when}`),
    timed ? row("timelock", `${PERIOD(Number(W(cfg, 8)))}, then ${PERIOD(Number(W(cfg, 9)))} to execute`) : null,
    row("execution", timed && ta.words.length >= 7 ? `${execution} · call gas ${grp(W(ta, 6))}` : execution),
  ].filter(Boolean));
  st.textContent = `config(), snapshot(${d.proposal}), tally(${d.proposal}) · eth_call · ${host(cfg.url)} · ${ms(performance.now() - t0)} · ${new Date().toLocaleTimeString()}`;
}

let pDao = "demo", pIdx = 0, askEpoch = 0;
function renderHolders() {
  const d = DAOS[pDao], names = daoNames(d), box = $("holders");
  box.textContent = "";
  d.proofs.forEach((p, i) => {
    box.append(h("button", { type: "button", role: "radio", "aria-checked": String(i === pIdx), tabindex: i === pIdx ? "0" : "-1", onclick: () => { pIdx = i; renderHolders(); ask("own"); } },
      names[i], h("span", { class: "mono" }, short(p.holder))));
  });
  const next = (pIdx + 1) % d.proofs.length;
  $("borrow").textContent = `Use ${names[pIdx]}’s proof for ${names[next]}`;
  $("power-note").textContent = `Proof fetched at the snapshot block when the proposal opened (block ${grp(d.block)}); the contract call is live.`;
}

async function ask(mode) {
  const d = DAOS[pDao], names = daoNames(d), n = d.proofs.length;
  const p = d.proofs[pIdx], q = d.proofs[(pIdx + 1) % n];
  let holder = p.holder, proof = p.proof, desc, tweak = "";
  if (mode === "borrow") {
    holder = q.holder;
    desc = [`votingPower(${d.proposal}, `, h("b", null, names[(pIdx + 1) % n]), ", ", h("b", null, `${names[pIdx]}’s proof`), ")"];
  } else if (mode === "flip") {
    const all = proof.map(strip).join(""), at = Math.floor(all.length / 4);
    const from = all.slice(2 * at, 2 * at + 2);
    proof = chain.flipByte(proof, at);
    const to = proof.map(strip).join("").slice(2 * at, 2 * at + 2);
    tweak = `byte ${grp(at)} of ${grp(all.length / 2)} flipped: ${from} → ${to}`;
    desc = [`votingPower(${d.proposal}, `, h("b", null, names[pIdx]), ", ", h("b", null, `${names[pIdx]}’s proof, one byte flipped`), ")"];
  } else {
    desc = [`votingPower(${d.proposal}, `, h("b", null, names[pIdx]), ", ", h("b", null, `${names[pIdx]}’s proof`), ")"];
  }
  const out = $("answer"), ep = ++askEpoch;
  out.className = "answer";
  out.textContent = "";
  out.append(h("div", { class: "call" }, ...desc, ` on Plebiscite · ${d.key === "demo" ? "DemoToken" : "USDC"}`), h("div", { class: "meta" }, `asking ${host(SEPOLIA[0])}…`));
  const r = await chain.viewAny(SEPOLIA, d.dao, chain.votingPowerCall({ id: d.proposal, holder, balanceProof: proof }));
  if (ep !== askEpoch) return;
  out.textContent = "";
  const meta = h("div", { class: "meta" }, `eth_call · latest · ${host(r.url)} · ${ms(r.ms)} · proof saved at block ${grp(d.block)}${tweak ? " · " + tweak : ""}`);
  const call = h("div", { class: "call" }, ...desc, ` on Plebiscite · ${d.key === "demo" ? "DemoToken" : "USDC"}`);
  if (r.ok) {
    const v = BigInt(r.words[0]);
    out.className = "answer ok";
    out.append(...[call, h("div", { class: "res" }, amount(d, r.words[0]), h("small", null, `${d.unit} of voting power`)),
      v === 0n ? h("div", { class: "note" }, "Zero: the proof is good and the balance was empty. A vote with it would be refused (NoWeight).") : null, meta].filter(Boolean));
  } else if (r.revert) {
    out.className = "answer no";
    out.append(call, h("div", { class: "res" }, `Refused: ${r.revert.error}(${r.revert.reason})`),
      h("div", { class: "note" }, mode === "borrow" ? `The proof leads to ${names[pIdx]}’s balance slot, not ${names[(pIdx + 1) % n]}’s, so it does not prove anything about ${names[(pIdx + 1) % n]}.` : mode === "flip" ? "The flipped node no longer hashes to the reference its parent holds." : "The contract refused this proof."), meta);
  } else {
    out.className = "answer no";
    out.append(call, h("div", { class: "err" }, `${host(r.url)}: ${r.message}`), h("button", { type: "button", class: "btn-line", onclick: () => ask(mode) }, "Retry"));
  }
}

function setupPlebiscite() {
  for (const key of ["demo", "usdc"]) {
    const s = snaps.daos[key];
    DAOS[key] = { key, ...s, dec: key === "demo" ? 18 : 6, unit: key === "demo" ? "tokens" : "USDC" };
  }
  document.querySelectorAll("#power [role=tab]").forEach((b, j, all) => {
    b.addEventListener("click", () => {
      pDao = b.dataset.dao; pIdx = 0;
      all.forEach((x) => { x.setAttribute("aria-selected", String(x === b)); x.tabIndex = x === b ? 0 : -1; });
      renderHolders();
      $("answer").textContent = "";
    });
    b.addEventListener("keydown", (e) => { const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (d) { e.preventDefault(); const k = all[(j + d + all.length) % all.length]; k.focus(); k.click(); } });
  });
  $("ask").addEventListener("click", () => ask("own"));
  $("borrow").addEventListener("click", () => ask("borrow"));
  $("pflip").addEventListener("click", () => ask("flip"));
  renderHolders();
  let loaded = false;
  const load = () => { if (loaded) return; loaded = true; loadDao("demo"); loadDao("usdc"); ask("own"); };
  if (location.hash === "#plebiscite") load();
  else new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); load(); } }, { rootMargin: "600px 0px" }).observe($("plebiscite"));
}

// ---- wiring ----------------------------------------------------------------------------------

function tabs(list, onPick) {
  list.forEach((b, j) => {
    b.addEventListener("click", () => onPick(j));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const k = (j + d + list.length) % list.length;
      list[k].focus();
      onPick(k);
    });
  });
}

const pickerTabs = [$("tab-saved"), $("tab-live")];
tabs(pickerTabs, (j) => {
  pickerTabs.forEach((b, k) => { b.setAttribute("aria-selected", String(j === k)); b.tabIndex = j === k ? 0 : -1; });
  $("panel-saved").hidden = j !== 0;
  $("panel-live").hidden = j !== 1;
});
form.addEventListener("submit", liveRead);
form.addEventListener("change", (e) => { syncForm(); if (e.target.id === "net") onNet(); if (e.target.id === "contract") onContract(); });
$("contract").addEventListener("input", noteContract);
syncForm();

(async () => {
  try {
    const [wasm, man, idx, d, s] = await Promise.all([
      fetch("/public/ferrotype.wasm").then((r) => { if (!r.ok) throw new Error("ferrotype.wasm: HTTP " + r.status); return r.arrayBuffer(); }),
      fetch("/public/ferrotype.manifest.json").then((r) => r.json()),
      fetch("/public/runs/index.json").then((r) => r.json()),
      fetch("/public/deployments/sepolia.json").then((r) => r.json()),
      fetch("/public/deployments/sepolia-snapshots.json").then((r) => r.json()),
    ]);
    manifest = man; index = idx; dep = d; snaps = s;
    TOKENS.sepolia[dep.usdc.toLowerCase()] = { token: "USDC", dec: 6, layout: 2, base: 9, holder: snaps.daos.usdc.proofs[0].holder };
    TOKENS.sepolia[dep.contracts.DemoToken.toLowerCase()] = { token: "tokens", dec: 18, layout: 0, base: 0, holder: dep.voters.alice };
    noteContract();
    fe = await loadFerrotype(wasm);
    const sha = await sha256(wasm);
    if (sha) {
      const stamp = $("stamp");
      stamp.textContent = `ferrotype.wasm · ${grp(wasm.byteLength)} bytes · sha256 ${sha.slice(0, 12)}… ${sha === manifest.module.sha256 ? "= its manifest" : "≠ its manifest"} · ${manifest.compiler}`;
    }
    if (document.fonts) {
      await Promise.race([
        Promise.all([document.fonts.ready, document.fonts.load("500 48px Gambetta"), document.fonts.load("400 15px Switzer"), document.fonts.load('400 11px "JetBrains Mono"')]),
        new Promise((r) => setTimeout(r, 1500)),
      ]).catch(() => {});
    }
    band = createBand(fe, {
      svg: $("u"), box: $("band"), tip: $("tip"), ro1: $("ro1"), ro2: $("ro2"),
      steps: document.querySelectorAll(".steps button"), flip: $("flip"), restore: $("restore"),
    }, { keepDamage: true, onBytes });
    tabs(presetBtns, (j) => pickPreset(presetBtns[j].dataset.fixture));
    setupPlebiscite();
    await pickPreset("usdc");
  } catch (e) {
    console.error(e);
    $("ro1").textContent = `The verifier did not load in this browser (${e.message}), so nothing here is shown as checked.`;
  }
})();

const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((n) => io.observe(n));
