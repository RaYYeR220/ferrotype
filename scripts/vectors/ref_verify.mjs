// Reference verifier for Ferrotype secure-trie proofs.
//
// Mirrors the error semantics of the Fe verifier exactly (see README.md):
//   result  = { found: true, value } | { found: false } | { error: Kind }
//   Kind    = HashMismatch | MissingNode | BadReference | Malformed | ExtraNodes
//
// `verify(root, path, proof)` walks the 64-nibble `path` (keccak256 of the key)
// from `root` through the proof entries and returns { result, trace }. The trace
// is only used by the generator to classify cases (exclusion shape, inline nodes,
// where each hashed entry is referenced from); it is not part of the semantics.
//
// Run directly (`node ref_verify.mjs [files...]`) to re-check every vector in
// fixtures/synthetic/*.json against its `expect`; exits non-zero on any mismatch.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256 } from 'ethereum-cryptography/keccak.js'

export const EMPTY_ROOT_HEX = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'

export class VerifyError extends Error {
  constructor(kind, detail) {
    super(`${kind}: ${detail}`)
    this.kind = kind
  }
}
const fail = (kind, detail) => {
  throw new VerifyError(kind, detail)
}

// ---------------------------------------------------------------- hex helpers

export function hexToBytes(h) {
  if (typeof h !== 'string' || !/^0x([0-9a-f]{2})*$/.test(h)) throw new Error(`bad hex: ${h}`)
  return Uint8Array.from(Buffer.from(h.slice(2), 'hex'))
}
export const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex')
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// ------------------------------------------------------------ strict RLP decode
// Items: { list: false, bytes, start, end } | { list: true, items, start, end }
// start/end are byte offsets of the whole item (header included) in the input.
// Any malformed or non-canonical encoding throws Malformed.

function decodeItem(buf, pos, limit) {
  if (pos >= limit) fail('Malformed', 'rlp: unexpected end')
  const b0 = buf[pos]
  if (b0 < 0x80) return { list: false, bytes: buf.subarray(pos, pos + 1), start: pos, end: pos + 1 }
  let isList, len, hdr
  if (b0 <= 0xb7) {
    isList = false; len = b0 - 0x80; hdr = 1
  } else if (b0 <= 0xbf) {
    isList = false; [len, hdr] = longLen(buf, pos, limit, b0 - 0xb7)
  } else if (b0 <= 0xf7) {
    isList = true; len = b0 - 0xc0; hdr = 1
  } else {
    isList = true; [len, hdr] = longLen(buf, pos, limit, b0 - 0xf7)
  }
  const start = pos, body = pos + hdr, end = body + len
  if (end > limit) fail('Malformed', 'rlp: item overruns input')
  if (!isList) {
    if (len === 1 && buf[body] < 0x80) fail('Malformed', 'rlp: non-canonical single byte')
    return { list: false, bytes: buf.subarray(body, end), start, end }
  }
  const items = []
  let p = body
  while (p < end) {
    const it = decodeItem(buf, p, end)
    items.push(it)
    p = it.end
  }
  return { list: true, items, start, end }
}

function longLen(buf, pos, limit, n) {
  if (pos + 1 + n > limit) fail('Malformed', 'rlp: truncated length')
  if (buf[pos + 1] === 0) fail('Malformed', 'rlp: length with leading zero')
  let len = 0
  for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 1 + i]
  if (len < 56) fail('Malformed', 'rlp: long form for short payload')
  return [len, 1 + n]
}

export function decodeRlp(buf) {
  const it = decodeItem(buf, 0, buf.length)
  if (it.end !== buf.length) fail('Malformed', 'rlp: trailing bytes')
  return it
}

// -------------------------------------------------------------------- verify

function nibblesOf(bytes) {
  const out = []
  for (const b of bytes) out.push(b >> 4, b & 0x0f)
  return out
}

// Hex-prefix decode of a leaf/extension path item.
function hexPrefix(item) {
  if (item.list) fail('Malformed', 'hp path is a list')
  const hp = item.bytes
  if (hp.length === 0) fail('Malformed', 'empty hp path')
  const flag = hp[0] >> 4
  if (flag > 3) fail('Malformed', `hp flag ${flag}`)
  const odd = (flag & 1) === 1
  if (!odd && (hp[0] & 0x0f) !== 0) fail('Malformed', 'non-zero hp pad nibble')
  const nibs = odd ? [hp[0] & 0x0f] : []
  for (let i = 1; i < hp.length; i++) nibs.push(hp[i] >> 4, hp[i] & 0x0f)
  return { isLeaf: flag >= 2, nibs }
}

// Turn a child item into a reference. `inBranch` lets an empty string mean "absent".
function childRef(item, inBranch) {
  if (item.list) {
    const len = item.end - item.start
    if (len >= 32) fail('BadReference', `inline node of ${len} bytes`)
    return { kind: 'inline', item }
  }
  if (inBranch && item.bytes.length === 0) return { kind: 'empty' }
  if (item.bytes.length !== 32) fail('BadReference', `${item.bytes.length}-byte reference`)
  return { kind: 'hash', hash: item.bytes }
}

/**
 * @param {string|Uint8Array} root  32-byte root
 * @param {string|Uint8Array} path  32-byte path (keccak256(key))
 * @param {(string|Uint8Array)[]} proof  RLP nodes
 * @returns {{ result: object, trace: object }}
 */
export function verify(root, path, proof) {
  const rootB = typeof root === 'string' ? hexToBytes(root) : root
  const pathB = typeof path === 'string' ? hexToBytes(path) : path
  const entries = proof.map((p) => (typeof p === 'string' ? hexToBytes(p) : p))
  if (rootB.length !== 32 || pathB.length !== 32) throw new Error('root/path must be 32 bytes')
  const key = nibblesOf(pathB)
  const trace = { nodes: [], shape: null, used: 0 }
  try {
    const result = walk(rootB, key, entries, trace)
    if (trace.used < entries.length) fail('ExtraNodes', `${entries.length - trace.used} unused entries`)
    return { result, trace }
  } catch (e) {
    if (!(e instanceof VerifyError)) throw e
    return { result: { error: e.kind }, trace: { ...trace, detail: e.message } }
  }
}

function walk(rootB, key, entries, trace) {
  if (entries.length === 0 && eq(rootB, hexToBytes(EMPTY_ROOT_HEX))) {
    trace.shape = 'empty-trie'
    return { found: false }
  }
  let ref = { kind: 'hash', hash: rootB }
  let from = null // { entry, item } that referenced the next hashed node
  let depth = 0
  for (;;) {
    let node, info
    if (ref.kind === 'hash') {
      if (trace.used >= entries.length) fail('MissingNode', `no entry for node at depth ${depth}`)
      const idx = trace.used++
      const enc = entries[idx]
      if (!eq(keccak256(enc), ref.hash)) fail('HashMismatch', `entry ${idx}`)
      node = decodeRlp(enc)
      info = { entry: idx, inline: false, depth, refFrom: from, len: enc.length }
    } else {
      node = ref.item
      info = { entry: null, inline: true, depth, parent: from, start: node.start, end: node.end, len: node.end - node.start }
    }
    trace.nodes.push(info)
    // Item offsets (start/end) are byte offsets inside the hashed entry that holds the node.
    const curEntry = info.inline ? from.entry : info.entry
    if (!node.list) fail('Malformed', 'node is not a list')

    if (node.items.length === 17) {
      info.type = 'branch'
      if (depth >= 64) fail('Malformed', 'branch at depth 64')
      const nib = key[depth]
      const child = node.items[nib]
      depth += 1
      const r = childRef(child, true)
      if (r.kind === 'empty') {
        trace.shape = 'empty-slot'
        return { found: false }
      }
      from = { entry: curEntry, item: nib, start: child.start, end: child.end }
      ref = r
      continue
    }

    if (node.items.length === 2) {
      const { isLeaf, nibs } = hexPrefix(node.items[0])
      const want = key.slice(depth, depth + nibs.length)
      const matches = depth + nibs.length <= 64 && nibs.every((n, i) => n === want[i])
      if (isLeaf) {
        info.type = 'leaf'
        if (depth + nibs.length !== 64) fail('Malformed', `leaf ends at depth ${depth + nibs.length}`)
        if (!matches) {
          trace.shape = 'leaf-diverge'
          return { found: false }
        }
        const v = node.items[1]
        if (v.list) fail('Malformed', 'leaf value is a list')
        return { found: true, value: bytesToHex(v.bytes) }
      }
      info.type = 'extension'
      if (nibs.length === 0) fail('Malformed', 'empty extension path')
      if (depth + nibs.length >= 64) fail('Malformed', `extension reaches depth ${depth + nibs.length}`)
      if (!matches) {
        trace.shape = 'ext-diverge'
        return { found: false }
      }
      depth += nibs.length
      const child = node.items[1]
      from = { entry: curEntry, item: 1, start: child.start, end: child.end }
      ref = childRef(child, false)
      continue
    }

    fail('Malformed', `node with ${node.items.length} items`)
  }
}

// ---------------------------------------------------------- vector self-check

/** Compare a verify() result with a vector's `expect`. Returns null if equal, else a message. */
export function compareExpect(result, expect) {
  if ('error' in expect) {
    return result.error === expect.error ? null : `expected error ${expect.error}, got ${JSON.stringify(result)}`
  }
  if (expect.found === false) {
    return result.found === false && !('error' in result) ? null : `expected absent, got ${JSON.stringify(result)}`
  }
  if (expect.found === true) {
    return result.found === true && result.value === expect.value
      ? null
      : `expected found ${expect.value}, got ${JSON.stringify(result)}`
  }
  return `bad expect ${JSON.stringify(expect)}`
}

/** Decode a stored storage value (RLP string of a minimal big-endian uint) to a 32-byte word. */
export function wordOf(valueHex) {
  const it = decodeRlp(hexToBytes(valueHex))
  if (it.list) throw new Error('value is a list')
  const b = it.bytes
  if (b.length === 0 || b.length > 32 || b[0] === 0) throw new Error(`value ${valueHex} is not a minimal non-zero uint`)
  return '0x' + Buffer.from(b).toString('hex').padStart(64, '0')
}

/** Full check of one vector: path = keccak(key), word consistency, verify() == expect. */
export function checkVector(c) {
  const problems = []
  if (bytesToHex(keccak256(hexToBytes(c.key))) !== c.path) problems.push('path != keccak256(key)')
  if (hexToBytes(c.key).length !== 32) problems.push('key is not 32 bytes')
  if (c.expect.found === true) {
    try {
      if (wordOf(c.expect.value) !== c.expect.word) problems.push('word does not match value')
    } catch (e) {
      problems.push(e.message)
    }
  }
  const { result } = verify(c.root, c.path, c.proof)
  const m = compareExpect(result, c.expect)
  if (m) problems.push(m)
  return problems
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  let files = argv
  if (files.length === 0) {
    const dir = resolve(here, '../../fixtures/synthetic')
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f))
  }
  let total = 0, bad = 0
  for (const f of files) {
    const cases = JSON.parse(readFileSync(f, 'utf8'))
    const kinds = {}
    for (const c of cases) {
      total++
      const k = 'error' in c.expect ? c.expect.error : c.expect.found ? 'found' : 'absent'
      kinds[k] = (kinds[k] ?? 0) + 1
      const p = checkVector(c)
      if (p.length) {
        bad++
        console.error(`FAIL ${f} :: ${c.name}: ${p.join('; ')}`)
      }
    }
    console.log(`${f.split(/[\\/]/).pop()}: ${cases.length} cases ${JSON.stringify(kinds)}`)
  }
  console.log(`${total - bad}/${total} vectors agree with ref_verify`)
  if (bad) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
