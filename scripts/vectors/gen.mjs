// Deterministic generator of secure-trie (keccak256-keyed MPT) proof vectors for Ferrotype.
//
// Reference implementation: @ethereumjs/trie (useKeyHashing: true) builds every trie and
// produces every proof (trie.createProof). Proofs are normalised to the eth_getProof
// format: @ethereumjs/trie also emits embedded (inline, < 32 byte) nodes as their own
// entries, those are dropped here (see README.md).
//
// Every vector is checked twice before anything is written: by ref_verify.mjs (the exact
// Fe error semantics) and, for valid proofs, by @ethereumjs/trie's own verifyProof.
// Any disagreement aborts the run. Output is byte-identical across runs (seeded PRNG).
//
// Usage: node gen.mjs        (writes ../../fixtures/synthetic/*.json)

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RLP } from '@ethereumjs/rlp'
import { Trie } from '@ethereumjs/trie'
import { keccak256 } from 'ethereum-cryptography/keccak.js'
import {
  EMPTY_ROOT_HEX,
  bytesToHex as hex,
  checkVector,
  compareExpect,
  decodeRlp,
  hexToBytes,
  verify,
} from './ref_verify.mjs'

const SEED = 'ferrotype-vectors/v1'
const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, '../../fixtures/synthetic')
const MAX_FILE_BYTES = 2 * 1024 * 1024

const STATS = { inlineEntriesStripped: 0, inlineSearch: {}, wrongKeySkipped: [], ejs: {} }

function die(msg) {
  console.error(`FATAL: ${msg}`)
  process.exit(1)
}
function assert(cond, msg) {
  if (!cond) die(msg)
}

// ------------------------------------------------------------------ bytes utils

const utf8 = (s) => new TextEncoder().encode(s)
const kec = (b) => keccak256(b)
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const concat = (...xs) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of xs) out.set(x, (o += x.length) - x.length)
  return out
}
function u256(n) {
  const b = new Uint8Array(32)
  let x = BigInt(n)
  for (let i = 31; i >= 0; i--, x >>= 8n) b[i] = Number(x & 0xffn)
  return b
}
const bytesToBig = (b) => (b.length ? BigInt(hex(b)) : 0n)
function minimalBytes(word) {
  let h = word.toString(16)
  if (h.length % 2) h = '0' + h
  return hexToBytes('0x' + h)
}
const storedValue = (word) => RLP.encode(minimalBytes(word)) // what Ethereum storage puts in the leaf
const wordHex = (word) => '0x' + word.toString(16).padStart(64, '0')
function nibbles(bytes) {
  const out = []
  for (const b of bytes) out.push(b >> 4, b & 0x0f)
  return out
}
function lcp(a, b) {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return i
}
function hpEncode(nibs, isLeaf) {
  const odd = nibs.length % 2
  const flag = (isLeaf ? 2 : 0) + odd
  const out = [odd ? (flag << 4) | nibs[0] : flag << 4]
  for (let i = odd; i < nibs.length; i += 2) out.push((nibs[i] << 4) | nibs[i + 1])
  return Uint8Array.from(out)
}
function hpDecode(hp) {
  const flag = hp[0] >> 4
  const nibs = flag & 1 ? [hp[0] & 0x0f] : []
  for (let i = 1; i < hp.length; i++) nibs.push(hp[i] >> 4, hp[i] & 0x0f)
  return { isLeaf: flag >= 2, nibs }
}

// ------------------------------------------------------------------------ PRNG
// xoshiro128** seeded from keccak256(SEED/label); one independent stream per label.

const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0
class Rng {
  constructor(label) {
    const h = kec(utf8(`${SEED}/${label}`))
    this.s = new Uint32Array(4)
    for (let i = 0; i < 4; i++) this.s[i] = ((h[4 * i] << 24) | (h[4 * i + 1] << 16) | (h[4 * i + 2] << 8) | h[4 * i + 3]) >>> 0
  }
  u32() {
    const s = this.s
    const r = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0
    const t = s[1] << 9
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 11)
    return r
  }
  int(n) {
    const lim = Math.floor(2 ** 32 / n) * n
    let x
    do x = this.u32()
    while (x >= lim)
    return x % n
  }
  bytes(n) {
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i++) b[i] = this.u32() >>> 24
    return b
  }
  pick(a) {
    return a[this.int(a.length)]
  }
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  sample(a, k) {
    return this.shuffle(a.slice()).slice(0, k)
  }
}

// ----------------------------------------------------------------------- values

const KINDS = ['full', 'tiny', 'medium', 'byte80']
function makeWord(rng, kind) {
  switch (kind) {
    case 'tiny': // 1..0x7f: stored as a single byte (RLP of a byte < 0x80 is itself)
      return BigInt(1 + rng.int(0x7f))
    case 'byte80': // 0x80..0xff: stored as 0x81 xx
      return BigInt(0x80 + rng.int(0x80))
    case 'medium': {
      const b = rng.bytes(2 + rng.int(30)) // 2..31 bytes
      b[0] = 1 + rng.int(255)
      return bytesToBig(b)
    }
    case 'full': {
      const b = rng.bytes(32) // full 32-byte word, stored as 0xa0 || 32 bytes
      b[0] = 1 + rng.int(255)
      return bytesToBig(b)
    }
  }
  die(`unknown kind ${kind}`)
}
function pickKind(rng) {
  const r = rng.int(100)
  return r < 35 ? 'full' : r < 65 ? 'tiny' : r < 90 ? 'medium' : 'byte80'
}
// Storage-like keys: a quarter are small slot numbers, the rest random 32-byte words.
const randomKey = (rng) => (rng.int(4) === 0 ? u256(rng.int(1 << 20)) : rng.bytes(32))

// ------------------------------------------------------------------------ tries

class SecureTrie {
  constructor(label) {
    this.label = label
    this.t = new Trie({ useKeyHashing: true })
    this.entries = new Map() // keyHex -> { key, word, kind, stored }
  }
  get root() {
    return this.t.root()
  }
  get size() {
    return this.entries.size
  }
  has(key) {
    return this.entries.has(hex(key))
  }
  async put(key, word, kind) {
    assert(key.length === 32 && !this.has(key), `${this.label}: bad or duplicate key`)
    assert(word > 0n, 'zero slots are never stored')
    const stored = storedValue(word)
    await this.t.put(key, stored)
    this.entries.set(hex(key), { key, word, kind, stored })
  }
  // eth_getProof-style proof: @ethereumjs/trie's createProof also lists embedded nodes
  // (RLP < 32 bytes, reached inline through their parent); drop them, keep the root.
  async proof(key) {
    const raw = await this.t.createProof(key)
    const kept = raw.filter((n, i) => i === 0 || n.length >= 32)
    this.lastStripped = raw.length - kept.length
    return kept
  }
}

async function randomTrie(label, size, rng, kindOf) {
  const t = new SecureTrie(label)
  for (let i = 0; i < size; i++) {
    let key
    do key = randomKey(rng)
    while (t.has(key))
    const kind = kindOf ? kindOf(i) : i < KINDS.length ? KINDS[i] : pickKind(rng)
    await t.put(key, makeWord(rng, kind), kind)
  }
  return t
}

// ------------------------------------------------------------------ case making

const ejsTrie = new Trie({ useKeyHashing: true }) // only used for its verifyProof
async function ejsVerify(root, key, proof) {
  try {
    return { value: await ejsTrie.verifyProof(root, key, proof) }
  } catch (e) {
    return { threw: e.message }
  }
}

const ALL_NAMES = new Set()
function baseCase(name, root, key, proof, expect, extra = {}) {
  assert(!ALL_NAMES.has(name), `duplicate case name ${name}`)
  ALL_NAMES.add(name)
  return { name, root: hex(root), key: hex(key), path: hex(kec(key)), proof: proof.map(hex), expect, ...extra }
}

// A valid (found / absent) case straight from the reference library.
async function validCase(trie, name, key, extra = {}) {
  const proof = await trie.proof(key)
  const e = trie.entries.get(hex(key))
  const expect = e ? { found: true, value: hex(e.stored), word: wordHex(e.word) } : { found: false }
  const c = baseCase(name, trie.root, key, proof, expect, { trie: trie.label, trieSize: trie.size, ...extra })
  const { result, trace } = verify(c.root, c.path, c.proof)
  const m = compareExpect(result, expect)
  assert(!m, `${name}: ref_verify disagrees with @ethereumjs/trie: ${m}`)
  const ejs = await ejsVerify(trie.root, key, proof)
  const ok = e ? ejs.value && eqBytes(ejs.value, e.stored) : ejs.value === null
  assert(ok, `${name}: @ethereumjs/trie verifyProof disagrees: ${JSON.stringify(ejs)}`)
  return { c, trace, proof, key, trie, stripped: trie.lastStripped }
}

// An invalid case: ref_verify must return exactly `kind`.
async function invalidCase(name, root, key, proof, kind, extra) {
  const c = baseCase(name, root, key, proof, { error: kind }, extra)
  const { result, trace } = verify(c.root, c.path, c.proof)
  assert(result.error === kind, `${name}: expected ${kind}, ref_verify says ${JSON.stringify(result)} (${trace.detail ?? ''})`)
  const ejs = await ejsVerify(root, key, proof)
  const tag = `${kind}:${ejs.threw !== undefined ? 'rejected' : 'accepted'}`
  STATS.ejs[tag] = (STATS.ejs[tag] ?? 0) + 1
  return c
}

const hashedNodes = (trace) => trace.nodes.filter((n) => !n.inline)
const finalNode = (rec) => rec.trace.nodes[rec.trace.nodes.length - 1]
const inlineNodes = (trace) => trace.nodes.filter((n) => n.inline)

// Re-link a modified proof: replace entry k, then rewrite each ancestor's reference to it
// (hashed parents only: inline nodes never have hashed children) and recompute the root.
function rehash(rec, k, newEnc, keep = rec.proof.length) {
  const out = rec.proof.slice(0, keep)
  out[k] = newEnc
  for (let j = k; ; ) {
    const info = rec.trace.nodes.find((n) => !n.inline && n.entry === j)
    if (!info.refFrom) break
    const p = info.refFrom.entry
    const dec = RLP.decode(out[p])
    assert(Array.isArray(dec) && (dec.length === 17 || dec.length === 2), 'rehash: parent is not a node')
    dec[info.refFrom.item] = kec(out[j])
    out[p] = RLP.encode(dec)
    j = p
  }
  return { root: kec(out[0]), proof: out }
}

// ------------------------------------------------------------------- grinding
// Secure-trie leaves are only embedded (< 32 bytes) when they sit at depth >= 9, i.e. a
// sibling shares the first 8 nibbles of keccak(key). Random tries of practical size never
// get that deep, so collect slot keys whose hashes share 32-bit (inline) and exactly
// 28-bit (boundary: 32-byte leaf) prefixes, birthday-style.

function grindPairs(rng, need8, need7) {
  const base = BigInt(rng.u32()) << 64n
  const m32 = new Map()
  const m28 = new Map()
  const used = new Set()
  const pairs8 = []
  const pairs7 = []
  let i = 0
  for (; pairs8.length < need8 || pairs7.length < need7; i++) {
    assert(i < 4_000_000, 'grinding did not converge')
    const h = kec(u256(base + BigInt(i)))
    const p32 = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
    const p28 = p32 >>> 4
    const j = m32.get(p32)
    if (j === undefined) m32.set(p32, i)
    else if (pairs8.length < need8 && !used.has(j) && !used.has(i)) {
      pairs8.push([j, i])
      used.add(j).add(i)
    }
    const o = m28.get(p28)
    if (o === undefined) m28.set(p28, { i, p32 })
    else if (pairs7.length < need7 && o.p32 !== p32 && !used.has(o.i) && !used.has(i)) {
      pairs7.push([o.i, i]) // first 7 nibbles equal, 8th differs
      used.add(o.i).add(i)
    }
  }
  const key = (n) => u256(base + BigInt(n))
  return { pairs8: pairs8.map(([a, b]) => [key(a), key(b)]), pairs7: pairs7.map(([a, b]) => [key(a), key(b)]), hashed: i }
}

function grindKeyWithLcp(rng, refKey, want) {
  const ref = nibbles(kec(refKey))
  for (let i = 0; i < 2_000_000; i++) {
    const k = rng.bytes(32)
    if (lcp(nibbles(kec(k)), ref) === want) return k
  }
  die('grindKeyWithLcp did not converge')
}

// =================================================================== groups

async function main() {
  const t0 = Date.now()
  const inclusion = []
  const inline = []
  const exclusion = []
  const invalid = []
  const recs = { incl: [], inl: [], excl: [], sibling: [], boundary: [] }
  const tries = []

  // ---------------------------------------------------------------- inclusion
  const rngI = new Rng('inclusion')
  const plan = [
    ['n1-full', 1, 1, () => 'full'],
    ['n1-tiny', 1, 1, () => 'tiny'],
    ['n2', 2, 2],
    ['n3', 3, 3],
    ['n10', 10, 8],
    ['n100', 100, 16],
    ['n1000', 1000, 24],
    ['n5000', 5000, 28],
  ]
  for (const [label, size, count, kindOf] of plan) {
    const t = await randomTrie(label, size, rngI, kindOf)
    tries.push(t)
    // stratified pick so every trie size proves tiny and full values where it has them
    const byKind = Object.fromEntries(KINDS.map((k) => [k, []]))
    for (const e of t.entries.values()) byKind[e.kind].push(e)
    for (const k of KINDS) rngI.shuffle(byKind[k])
    const chosen = []
    for (let r = 0; chosen.length < count; r++) {
      const list = byKind[KINDS[r % KINDS.length]]
      if (list.length) chosen.push(list.pop())
      assert(r < 10 * count + 10, `${label}: not enough keys`)
    }
    for (const [i, e] of chosen.entries()) {
      const rec = await validCase(t, `inclusion/${label}/${e.kind}/${i}`, e.key, { valueKind: e.kind })
      assert(inlineNodes(rec.trace).length === 0, `${rec.c.name}: unexpected inline node`)
      inclusion.push(rec.c)
      recs.incl.push(rec)
    }
  }

  // Tries shaped to have extension nodes on the path (root extension, nested extension).
  const rngE = new Rng('extension-tries')
  {
    const a = rngE.bytes(32)
    const t = new SecureTrie('ext2')
    await t.put(a, makeWord(rngE, 'full'), 'full')
    await t.put(grindKeyWithLcp(rngE, a, 2), makeWord(rngE, 'tiny'), 'tiny')
    tries.push(t)
    const a3 = rngE.bytes(32)
    const t3 = new SecureTrie('ext3')
    await t3.put(a3, makeWord(rngE, 'medium'), 'medium')
    await t3.put(grindKeyWithLcp(rngE, a3, 3), makeWord(rngE, 'full'), 'full')
    await t3.put(grindKeyWithLcp(rngE, a3, 1), makeWord(rngE, 'tiny'), 'tiny')
    tries.push(t3)
    for (const tt of [t, t3]) {
      for (const [i, e] of [...tt.entries.values()].entries()) {
        const rec = await validCase(tt, `inclusion/${tt.label}/${e.kind}/${i}`, e.key, { valueKind: e.kind })
        assert(rec.trace.nodes.some((n) => n.type === 'extension'), `${rec.c.name}: no extension on path`)
        inclusion.push(rec.c)
        recs.incl.push(rec)
      }
    }
  }

  // ------------------------------------------------------------------- inline
  const rngN = new Rng('inline')
  const g = grindPairs(rngN, 14, 3)
  STATS.grind = { hashed: g.hashed }
  const tiny = () => makeWord(rngN, 'tiny')
  const inlTries = []
  {
    const tp = new SecureTrie('inl-pair') // just one colliding pair: ext(8) -> branch -> 2 inline leaves
    for (const k of g.pairs8[0]) await tp.put(k, tiny(), 'tiny')
    const tm = await randomTrie('inl-n100', 100, rngN, () => 'tiny')
    for (const p of g.pairs8.slice(1, 5)) for (const k of p) await tm.put(k, tiny(), 'tiny')
    const tl = await randomTrie('inl-n5000', 5000, rngN, () => 'tiny')
    for (const p of g.pairs8.slice(5, 11)) for (const k of p) await tl.put(k, tiny(), 'tiny')
    for (const [a, b] of g.pairs8.slice(11, 14)) {
      await tl.put(a, tiny(), 'tiny') // embedded leaf ...
      await tl.put(b, makeWord(rngN, 'full'), 'full') // ... next to a hashed sibling
    }
    for (const p of g.pairs7) for (const k of p) await tl.put(k, tiny(), 'tiny')
    inlTries.push(tp, tm, tl)
    tries.push(tp, tm, tl)
  }
  const pairKeys8 = new Set(g.pairs8.flat().map(hex))
  const mixedFull = new Set(g.pairs8.slice(11).map(([, b]) => hex(b)))
  const boundaryKeys = new Set(g.pairs7.flat().map(hex))
  for (const t of inlTries) {
    // Search: prove every ground key plus a sample of background keys, keep proofs whose
    // walk actually goes through a branch child that is an RLP list (embedded node).
    const all = [...t.entries.values()]
    const cands = all.filter((e) => pairKeys8.has(hex(e.key)) || boundaryKeys.has(hex(e.key)))
    const bg = rngN.sample(all.filter((e) => !cands.includes(e)), 300)
    const s = (STATS.inlineSearch[t.label] = { trieSize: t.size, proved: 0, withInline: 0, bgWithInline: 0 })
    let n = 0
    for (const e of [...cands, ...bg]) {
      s.proved++
      const kh = hex(e.key)
      const tmpName = `tmp/${t.label}/${s.proved}`
      const rec = await validCase(t, tmpName, e.key, { valueKind: e.kind })
      ALL_NAMES.delete(tmpName)
      const inl = inlineNodes(rec.trace)
      if (inl.length) {
        s.withInline++
        if (!pairKeys8.has(kh)) s.bgWithInline++
        const node = inl[0]
        const last = finalNode(rec)
        const name = `inline/${t.label}/d${node.depth}/${n++}`
        ALL_NAMES.add(name)
        Object.assign(rec.c, {
          name,
          inlineDepth: node.depth,
          inlineLen: node.len,
          inlineParentEntry: node.parent.entry,
          inlineIsFinalLeaf: last === node && node.type === 'leaf',
        })
        assert(rec.c.expect.found && node.len < 32, `${name}: bad inline case`)
        inline.push(rec.c)
        recs.inl.push(rec)
        continue
      }
      assert(!(pairKeys8.has(kh) && e.kind === 'tiny'), `${kh}: tiny ground key has no inline node on its path`)
      if (mixedFull.has(kh)) {
        // hashed leaf whose parent branch also holds an embedded (inline) sibling
        const parent = rec.trace.nodes[rec.trace.nodes.length - 2]
        const br = decodeRlp(rec.proof[parent.entry])
        assert(br.items.some((it) => it.list), `${kh}: expected an inline sibling`)
        const name = `inclusion/inline-sibling/${t.label}/${recs.sibling.length}`
        ALL_NAMES.add(name)
        Object.assign(rec.c, { name })
        inclusion.push(rec.c)
        recs.sibling.push(rec)
      } else if (boundaryKeys.has(kh)) {
        // leaf whose RLP is exactly 32 bytes: must be hashed, not embedded
        const last = finalNode(rec)
        assert(!last.inline && last.len === 32, `${kh}: boundary leaf is ${last.len} bytes`)
        const name = `inclusion/boundary-leaf-32/${t.label}/${recs.boundary.length}`
        ALL_NAMES.add(name)
        Object.assign(rec.c, { name, leafLen: 32 })
        inclusion.push(rec.c)
        recs.boundary.push(rec)
      }
    }
  }
  // Inline siblings in one branch get byte-identical proofs (neither leaf costs an entry).
  STATS.siblingProofsIdentical = 0
  for (const [a, b] of g.pairs8.slice(0, 11)) {
    const ra = recs.inl.find((r) => eqBytes(r.key, a))
    const rb = recs.inl.find((r) => eqBytes(r.key, b))
    if (ra && rb && ra.c.proof.join() === rb.c.proof.join()) STATS.siblingProofsIdentical++
  }

  // ----------------------------------------------------------------- exclusion
  const rngX = new Rng('exclusion')
  for (const [i, key] of [u256(0), rngX.bytes(32), new Uint8Array(32).fill(0xff)].entries()) {
    const c = baseCase(`exclusion/empty-trie/${i}`, hexToBytes(EMPTY_ROOT_HEX), key, [], { found: false }, {
      trie: 'empty',
      trieSize: 0,
      shape: 'empty-trie',
    })
    const { result, trace } = verify(c.root, c.path, c.proof)
    assert(!compareExpect(result, c.expect) && trace.shape === 'empty-trie', `${c.name}: ref_verify disagrees`)
    const empty = new SecureTrie('empty')
    assert(hex(empty.root) === EMPTY_ROOT_HEX, 'ethereumjs empty root differs')
    assert((await empty.proof(key)).length === 0, 'ethereumjs empty-trie proof is not []')
    STATS.ejsEmptyTrie = await ejsVerify(empty.root, key, [])
    exclusion.push(c)
  }
  const quota = { 'empty-slot': 2, 'leaf-diverge': 2, 'ext-diverge': 3 }
  STATS.exclusionSearch = {}
  for (const t of tries) {
    const got = { 'empty-slot': 0, 'leaf-diverge': 0, 'ext-diverge': 0 }
    let tried = 0
    const budget = t.size >= 1000 ? 12000 : 3000
    for (; tried < budget && Object.keys(quota).some((s) => got[s] < quota[s]); tried++) {
      const key = randomKey(rngX)
      if (t.has(key)) continue
      const proof = await t.proof(key)
      const { result, trace } = verify(t.root, kec(key), proof)
      assert(result.found === false, `${t.label}: absent key not absent: ${JSON.stringify(result)}`)
      if (got[trace.shape] >= quota[trace.shape]) continue
      const rec = await validCase(t, `exclusion/${t.label}/${trace.shape}/${got[trace.shape]++}`, key)
      assert(rec.trace.shape === trace.shape, 'shape changed')
      rec.c.shape = trace.shape
      rec.c.terminalDepth = finalNode(rec).depth
      exclusion.push(rec.c)
      recs.excl.push(rec)
    }
    STATS.exclusionSearch[t.label] = { tried, ...got }
  }

  // ------------------------------------------------------------------- invalid
  const rngV = new Rng('invalid')
  const meta = (mutation, base, more = {}) => ({ mutation, base: base.c.name, ...more })
  const nm = (mutation, base, suffix = '') => `invalid/${mutation}/${base.c.name}${suffix}`
  const pickSpread = (list, k) => {
    // deterministic, evenly spread pick (covers every trie size)
    if (k >= list.length) return list.slice()
    const step = list.length / k
    return Array.from({ length: k }, (_, i) => list[Math.floor(i * step)])
  }
  const multi = (r) => r.proof.length >= 2

  // 1. one byte flipped inside a hashed node -> HashMismatch
  {
    const bases = [...pickSpread(recs.incl, 22), ...pickSpread(recs.excl.filter(multi), 8)]
    for (const [n, b] of bases.entries()) {
      const which = n % 3 === 0 ? 0 : n % 3 === 1 ? b.proof.length - 1 : rngV.int(b.proof.length)
      const proof = b.proof.map((x) => x.slice())
      const pos = rngV.int(proof[which].length)
      proof[which][pos] ^= 1 + rngV.int(255)
      invalid.push(
        await invalidCase(nm('flip-byte', b, `/e${which}b${pos}`), b.trie.root, b.key, proof, 'HashMismatch', meta('flip-byte', b, { entry: which, byte: pos })),
      )
    }
  }
  // 2. one byte flipped inside an embedded node (changes its parent's hash) -> HashMismatch
  for (const b of pickSpread(recs.inl, 8)) {
    const node = inlineNodes(b.trace)[0]
    const pe = node.parent.entry
    const pos = node.start + rngV.int(node.end - node.start)
    const proof = b.proof.map((x) => x.slice())
    proof[pe][pos] ^= 1 + rngV.int(255)
    invalid.push(
      await invalidCase(nm('flip-inline-byte', b, `/e${pe}b${pos}`), b.trie.root, b.key, proof, 'HashMismatch', meta('flip-inline-byte', b, { entry: pe, byte: pos })),
    )
  }
  // 3. wrong root -> HashMismatch
  {
    const bases = pickSpread([...recs.incl, ...recs.excl.filter((r) => r.proof.length)], 10)
    for (const [n, b] of bases.entries()) {
      let root, how
      if (n < 4) [root, how] = [rngV.bytes(32), 'random']
      else if (n < 7) [root, how] = [rngV.pick(tries.filter((t) => t !== b.trie)).root, 'other-trie']
      else if (n < 9) {
        root = b.trie.root.slice()
        const bit = rngV.int(256)
        root[bit >> 3] ^= 1 << (bit & 7)
        how = 'bit-flip'
      } else [root, how] = [hexToBytes(EMPTY_ROOT_HEX), 'empty-root']
      invalid.push(await invalidCase(nm('wrong-root', b, `/${how}`), root, b.key, b.proof, 'HashMismatch', meta('wrong-root', b, { how })))
    }
  }
  // 4. last proof entry dropped -> MissingNode
  for (const b of [...pickSpread(recs.incl, 12), ...pickSpread(recs.inl, 4), ...pickSpread(recs.excl.filter((r) => r.proof.length), 4)]) {
    invalid.push(await invalidCase(nm('drop-last', b), b.trie.root, b.key, b.proof.slice(0, -1), 'MissingNode', meta('drop-last', b)))
  }
  // 5. a middle entry dropped -> HashMismatch (next entry is not the referenced node)
  for (const b of pickSpread(recs.incl.filter((r) => r.proof.length >= 3), 5)) {
    const i = 1 + rngV.int(b.proof.length - 2)
    invalid.push(
      await invalidCase(nm('drop-middle', b, `/e${i}`), b.trie.root, b.key, b.proof.filter((_, j) => j !== i), 'HashMismatch', meta('drop-middle', b, { entry: i })),
    )
  }
  // 6. an unrelated valid node appended -> ExtraNodes
  {
    const donors = [...recs.incl, ...recs.excl].filter((r) => r.proof.length)
    for (const b of [...pickSpread(recs.incl, 10), ...pickSpread(recs.inl, 3), ...pickSpread(recs.excl.filter((r) => r.proof.length), 5)]) {
      const d = rngV.pick(donors.filter((r) => r.trie !== b.trie))
      const extra = rngV.pick(d.proof)
      invalid.push(
        await invalidCase(nm('append-node', b), b.trie.root, b.key, [...b.proof, extra], 'ExtraNodes', meta('append-node', b, { donor: d.c.name })),
      )
    }
  }
  // 7. proof of present key A presented for present key B -> predicted, then checked
  {
    const predict = (recA, keyB) => {
      const nA = nibbles(kec(recA.key))
      const nB = nibbles(kec(keyB))
      const d = lcp(nA, nB)
      const br = recA.trace.nodes.find((n) => n.type === 'branch' && n.depth === d && !n.inline)
      assert(br, 'paths of two present keys must split at a branch')
      const childB = decodeRlp(recA.proof[br.entry]).items[nB[d]]
      const after = recA.proof.length - br.entry - 1 // entries below the split = A's hashed child
      if (!childB.list) {
        assert(childB.bytes.length === 32, 'present sibling must be referenced')
        return after > 0
          ? { error: 'HashMismatch', reason: `paths split at depth ${d}; B's child is hashed but the next entry is A's child` }
          : { error: 'MissingNode', reason: `paths split at depth ${d}; A's leaf is embedded there so the proof ends, B's child is hashed` }
      }
      return after > 0
        ? { error: 'ExtraNodes', reason: `paths split at depth ${d}; B's leaf is embedded in the branch (found) but A's hashed child entries remain` }
        : { found: true, reason: `paths split at depth ${d}; both leaves embedded in the same branch, proofs identical` }
    }
    const pairs = []
    for (const b of pickSpread(recs.incl.filter((r) => r.trie.size >= 2), 12)) {
      const others = [...b.trie.entries.values()].filter((e) => !eqBytes(e.key, b.key))
      pairs.push([b, rngV.pick(others).key, 'random'])
    }
    for (const b of pickSpread(recs.inl, 3)) {
      const others = [...b.trie.entries.values()].filter((e) => !eqBytes(e.key, b.key))
      pairs.push([b, rngV.pick(others).key, 'random'])
    }
    for (const [a, bKey] of g.pairs8.slice(11, 14)) {
      const ra = recs.inl.find((r) => eqBytes(r.key, a))
      const rb = recs.sibling.find((r) => eqBytes(r.key, bKey))
      pairs.push([ra, bKey, 'embedded-A-for-hashed-B'], [rb, a, 'hashed-A-for-embedded-B'])
    }
    for (const [i, a] of pickSpread(recs.inl.filter((r) => r.trie.label !== 'inl-n5000'), 2).entries()) {
      const partner = g.pairs8.flat().find((k, j, arr) => eqBytes(arr[j ^ 1], a.key))
      pairs.push([a, partner, `embedded-siblings-${i}`])
    }
    for (const [a, keyB, how] of pairs) {
      const p = predict(a, keyB)
      const c = { root: a.trie.root, path: kec(keyB) }
      const { result } = verify(c.root, c.path, a.proof)
      assert(p.error ? result.error === p.error : result.found === true, `wrong-key ${a.c.name}: predicted ${JSON.stringify(p)}, ref_verify ${JSON.stringify(result)}`)
      if (!p.error) {
        STATS.wrongKeySkipped.push({ base: a.c.name, result: 'found', reason: p.reason })
        continue
      }
      const name = nm('wrong-key', a, `/${how}/${hex(keyB).slice(2, 10)}`)
      invalid.push(await invalidCase(name, a.trie.root, keyB, a.proof, p.error, meta('wrong-key', a, { how, reason: p.reason })))
    }
  }
  // 8. empty root edge cases (rules taken literally: an entry exists, so it must hash to the root)
  {
    const b = recs.incl[0]
    const empty = hexToBytes(EMPTY_ROOT_HEX)
    invalid.push(await invalidCase('invalid/empty-root/with-node', empty, b.key, [b.proof[0]], 'HashMismatch', { mutation: 'empty-root-with-node', base: b.c.name }))
    invalid.push(await invalidCase('invalid/empty-root/with-0x80', empty, b.key, [Uint8Array.from([0x80])], 'Malformed', { mutation: 'empty-root-with-0x80', base: b.c.name }))
  }
  // 9. structurally bad nodes, re-hashed up to a new root so every hash still checks out
  {
    const craft = async (mutation, b, kind, k, newEnc, keep, more = {}) => {
      const { root, proof } = rehash(b, k, newEnc, keep)
      invalid.push(await invalidCase(nm(mutation, b), root, b.key, proof, kind, meta(mutation, b, { entry: k, ...more })))
    }
    const hashedLeaf = (r) => r.c.expect.found && !finalNode(r).inline && finalNode(r).type === 'leaf'
    const leafBases = recs.incl.filter(hashedLeaf)
    const byLabel = (l) => leafBases.find((r) => r.trie.label === l)
    const evenLeaf = leafBases.filter((r) => finalNode(r).depth % 2 === 0 && finalNode(r).depth > 0)
    const lastIdx = (r) => r.proof.length - 1
    const leafDec = (r) => RLP.decode(r.proof[lastIdx(r)])

    // node shape
    for (const b of [byLabel('n1-full'), byLabel('n1000')]) {
      const [p, v] = leafDec(b)
      await craft('node-3-items', b, 'Malformed', lastIdx(b), RLP.encode([p, v, new Uint8Array(0)]))
    }
    await craft('node-is-string', byLabel('n100'), 'Malformed', lastIdx(byLabel('n100')), RLP.encode(byLabel('n100').proof.at(-1)))
    for (const b of [byLabel('n10'), byLabel('n5000')]) {
      const dec = RLP.decode(b.proof[0])
      assert(dec.length === 17, 'root should be a branch')
      await craft('branch-16-items', b, 'Malformed', 0, RLP.encode(dec.slice(0, 16)))
    }
    {
      const b = byLabel('n1000')
      const k = hashedNodes(b.trace).filter((n) => n.type === 'branch').at(-1).entry
      await craft('branch-18-items', b, 'Malformed', k, RLP.encode([...RLP.decode(b.proof[k]), new Uint8Array(0)]))
    }
    // hex-prefix
    for (const [b, flag] of [[byLabel('n1-tiny'), 4], [byLabel('n100'), 0xf]]) {
      const [p, v] = leafDec(b)
      const hp = p.slice()
      hp[0] = (flag << 4) | (hp[0] & 0x0f)
      await craft('hp-bad-flag', b, 'Malformed', lastIdx(b), RLP.encode([hp, v]), undefined, { flag })
    }
    for (const b of pickSpread(evenLeaf, 2)) {
      const [p, v] = leafDec(b)
      assert(p[0] === 0x20, 'even leaf path must start with 0x20')
      const hp = p.slice()
      hp[0] = 0x20 | (1 + rngV.int(15))
      await craft('hp-nonzero-pad', b, 'Malformed', lastIdx(b), RLP.encode([hp, v]))
    }
    // leaf / extension depth rules
    for (const b of [byLabel('n1-full'), byLabel('n100')]) {
      const [p, v] = leafDec(b)
      const { nibs } = hpDecode(p)
      await craft('leaf-ends-early', b, 'Malformed', lastIdx(b), RLP.encode([hpEncode(nibs.slice(0, -1), true), v]))
      await craft('leaf-ends-late', b, 'Malformed', lastIdx(b), RLP.encode([hpEncode([...nibs, rngV.int(16)], true), v]))
    }
    for (const b of [byLabel('n3'), byLabel('n1000')]) {
      const d = finalNode(b).depth
      const rest = nibbles(kec(b.key)).slice(d)
      await craft('ext-reaches-64', b, 'Malformed', lastIdx(b), RLP.encode([hpEncode(rest, false), rngV.bytes(32)]))
    }
    const extBases = [...recs.incl, ...recs.excl].filter((r) =>
      hashedNodes(r.trace).some((n) => n.type === 'extension' && r.trace.nodes.indexOf(n) < r.trace.nodes.length - 1),
    )
    const extOf = (r) => hashedNodes(r.trace).find((n) => n.type === 'extension' && r.trace.nodes.indexOf(n) < r.trace.nodes.length - 1)
    {
      const [b1, b2] = [extBases.find((r) => r.trie.label === 'ext2'), extBases.find((r) => r.trie.label === 'n5000') ?? extBases.at(-1)]
      for (const b of [b1, b2]) {
        const k = extOf(b).entry
        const [, child] = RLP.decode(b.proof[k])
        await craft('ext-empty-path', b, 'Malformed', k, RLP.encode([Uint8Array.from([0x00]), child]))
      }
      const even = extBases.find((r) => RLP.decode(r.proof[extOf(r).entry])[0][0] === 0x00 && RLP.decode(r.proof[extOf(r).entry])[0].length > 1)
      assert(even, 'need an even-length extension')
      {
        const k = extOf(even).entry
        const [p, child] = RLP.decode(even.proof[k])
        const hp = p.slice()
        hp[0] = 1 + rngV.int(15)
        await craft('hp-nonzero-pad-ext', even, 'Malformed', k, RLP.encode([hp, child]))
        const hp2 = p.slice()
        hp2[0] = 0x50
        await craft('hp-bad-flag-ext', even, 'Malformed', k, RLP.encode([hp2, child]), undefined, { flag: 5 })
      }
      // references
      for (const [b, how, mk] of [
        [b1, '31', (h) => h.slice(0, 31)],
        [b2, '33', (h) => concat(h, Uint8Array.from([0]))],
        [b1, 'empty', () => new Uint8Array(0)],
      ]) {
        const k = extOf(b).entry
        const [p, child] = RLP.decode(b.proof[k])
        await craft(`ext-ref-${how}`, b, 'BadReference', k, RLP.encode([p, mk(child)]))
      }
    }
    for (const [b, how, mk] of [
      [byLabel('n100'), '31', (h) => h.slice(0, 31)],
      [byLabel('n5000'), '33', (h) => concat(h, Uint8Array.from([0]))],
      [byLabel('n1000'), '20', (h) => h.slice(12)],
    ]) {
      const leaf = finalNode(b)
      const { entry: k, item } = leaf.refFrom
      const dec = RLP.decode(b.proof[k])
      dec[item] = mk(dec[item])
      await craft(`branch-ref-${how}`, b, 'BadReference', k, RLP.encode(dec))
    }
    // the next node embedded as a list although its RLP is >= 32 bytes
    for (const b of [byLabel('n1000'), recs.boundary[0]]) {
      const leaf = finalNode(b)
      const { entry: k, item } = leaf.refFrom
      const dec = RLP.decode(b.proof[k])
      dec[item] = RLP.decode(b.proof[leaf.entry])
      await craft('embed-large-node', b, 'BadReference', k, RLP.encode(dec), leaf.entry, { embeddedLen: b.proof[leaf.entry].length })
    }
  }

  // --------------------------------------------------------------------- write
  STATS.inlineEntriesStripped = [...recs.incl, ...recs.inl, ...recs.excl, ...recs.sibling, ...recs.boundary].reduce(
    (n, r) => n + r.stripped,
    0,
  )
  mkdirSync(OUT_DIR, { recursive: true })
  const groups = { 'inclusion.json': inclusion, 'inline.json': inline, 'exclusion.json': exclusion, 'invalid.json': invalid }
  let total = 0
  for (const [file, cases] of Object.entries(groups)) {
    for (const c of cases) {
      const p = checkVector(c)
      assert(p.length === 0, `${c.name}: ${p.join('; ')}`)
    }
    const s = JSON.stringify(cases, null, 2) + '\n'
    assert(Buffer.byteLength(s) < MAX_FILE_BYTES, `${file} is ${Buffer.byteLength(s)} bytes`)
    writeFileSync(join(OUT_DIR, file), s)
    total += cases.length
    console.log(`${file}: ${cases.length} cases, ${Buffer.byteLength(s)} bytes`)
  }
  const count = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})
  console.log('inclusion by kind:', count(inclusion, (c) => c.valueKind))
  console.log('inclusion by trie:', count(inclusion, (c) => c.trie))
  console.log('inline by trie:', count(inline, (c) => c.trie), 'final-leaf:', count(inline, (c) => c.inlineIsFinalLeaf))
  console.log('exclusion by shape:', count(exclusion, (c) => c.shape))
  console.log('invalid by mutation:', count(invalid, (c) => c.mutation))
  console.log('invalid by error:', count(invalid, (c) => c.expect.error))
  console.log('stats:', JSON.stringify(STATS, null, 1))
  console.log(`${total} vectors, all agree with ref_verify (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

await main()
