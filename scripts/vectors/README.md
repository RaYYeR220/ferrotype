# Synthetic proof vectors

Deterministic Merkle-Patricia proof vectors for Ferrotype's secure-trie verifier
(path = keccak256(key), as in Ethereum state and storage tries). Output goes to
`fixtures/synthetic/`.

## Reference implementation

- `@ethereumjs/trie` **6.2.1** with `useKeyHashing: true` builds every trie and
  produces every proof (`trie.createProof(key)`). 6.2.1 is the last release under
  that name; its successor is `@ethereumjs/mpt` 10.x.
- `@ethereumjs/rlp` 5.0.2, `@ethereumjs/util` 9.1.0, `ethereum-cryptography` 2.2.1 (keccak).
- Versions are pinned exactly in `package.json`, and `package-lock.json` pins the
  transitive dependencies. Tested on Node 24.13.0.

## Regenerate

```sh
cd scripts/vectors
npm ci
node gen.mjs          # writes fixtures/synthetic/*.json and ejs-verdicts.json (~15 s)
node ref_verify.mjs   # re-checks every vector on disk, exits 1 on any mismatch
```

Seed: `ferrotype-vectors/v1`. Each group draws from its own xoshiro128** stream,
seeded from `keccak256("ferrotype-vectors/v1/<label>")`. Reruns produce byte-identical
files. To confirm, compare `sha256sum ../../fixtures/synthetic/*.json` before and after.

`gen.mjs` aborts if any vector disagrees with `ref_verify.mjs`. Valid proofs must also
pass `@ethereumjs/trie`'s own `verifyProof`. What `verifyProof` makes of each invalid
vector (rejected or accepted, by expected error) is printed under `ejs` and written to
`ejs-verdicts.json`, which `scripts/render_readme.py` reads.

## Format

Each file is a JSON array of cases:

```json
{"name": "...", "root": "0x<32B>", "key": "0x<32B unhashed key>", "path": "0x<keccak256(key)>",
 "proof": ["0x<rlp node>", ...],
 "expect": {"found": true, "value": "0x<leaf bytes, RLP>", "word": "0x<32B uint>"}
          | {"found": false} | {"error": "HashMismatch|MissingNode|BadReference|Malformed|ExtraNodes"}}
```

Values are stored the way Ethereum storage stores them: the leaf holds `rlp(uint)`
(minimal big-endian bytes, never zero). `value` is those leaf bytes and `word` is the
decoded uint padded to 32 bytes. Other fields (`trie`, `trieSize`, `valueKind`, `shape`,
`mutation`, `base`, ...) are informational.

**Proof normalisation.** `createProof` in `@ethereumjs/trie` also emits embedded nodes
(RLP < 32 bytes, held inside their parent) as separate proof entries. The generator
drops every non-root entry shorter than 32 bytes. That matches `eth_getProof`/geth,
where an inline node costs no proof entry.

## Verifier semantics (`ref_verify.mjs`)

- Start at the root. Each hash reference takes the next proof entry. If its keccak
  doesn't match, the result is `HashMismatch`. If no entry is left, the result is
  `MissingNode`. The one exception is the empty root `0x56e8…b421` with `proof = []`,
  which means the key is absent.
- A list child is an inline node and takes no entry. If its encoding is 32 bytes or
  longer, the result is `BadReference`. A string child must be exactly 32 bytes, or
  the result is `BadReference`.
- A node with 17 items is a branch. Take the nibble at the current depth. An empty
  child means the key is absent.
- A node with 2 items is a leaf or extension with a hex-prefix path. Each of these is
  `Malformed`:
  - a flag greater than 3
  - a non-zero pad nibble on an even-length path
  - a leaf that doesn't end at exactly depth 64
  - an empty extension
  - an extension that reaches depth 64

  If the path differs from the key's next nibbles, the key is absent.
- Any other node is `Malformed`.
- Every vector is a storage trie, so a found value must be what storage keeps: a
  canonical RLP string of at most 32 bytes with no leading zero byte (zero is the
  empty string, never `0x00`). Anything else is `Malformed`, as in `state::storage`.
- Once the key is found or proven absent, any unused entry gives `ExtraNodes`.

## Groups

| file | cases | covers |
|---|---|---|
| `inclusion.json` | 97 | Random tries of 1, 2, 3, 10, 100, 1000 and 5000 keys. Value kinds: `tiny` (1..0x7f, single-byte RLP), `byte80` (0x81xx), `medium` (2–31 B) and `full` (32 B). Also: the `ext2`/`ext3` tries with extensions on the path; `inline-sibling` (a hashed leaf whose parent branch also holds an embedded leaf); and `boundary-leaf-32` (leaf RLP exactly 32 B, so it is hashed, not embedded). |
| `inline.json` | 25 | Proofs whose walk passes through an embedded leaf (31 B, depth 9–10). Fields: `inlineDepth`, `inlineLen`, `inlineParentEntry`, `inlineIsFinalLeaf` (always true, see below). |
| `exclusion.json` | 73 | `shape`: `empty-slot` 20, `leaf-diverge` 23, `ext-diverge` 24, `empty-trie` 6 (root `0x56e8…b421`, with `proof: []` and with `proof: ["0x80"]`, the empty root node that anvil and reth return). |
| `invalid.json` | 148 | Mutations of valid proofs (see below). |

Mutations in `invalid.json`:

- `flip-byte` and `flip-inline-byte` change one byte in a hashed or embedded node.
  Expected: `HashMismatch`.
- `wrong-root` replaces the root with a random value, another trie's root, a bit-flipped
  root, or the empty root. Expected: `HashMismatch`.
- `drop-last` removes the last entry. Expected: `MissingNode`.
- `drop-middle` removes an entry from the middle. Expected: `HashMismatch`.
- `append-node` adds a node from an unrelated trie. Expected: `ExtraNodes`.
- `wrong-key` checks key A's proof against another present key B. Each `reason` field
  explains the outcome:
  - random pairs: `HashMismatch`
  - A's leaf embedded, B's hashed: `MissingNode`
  - A's leaf hashed, B's embedded: `ExtraNodes`

  Two embedded siblings in one branch have byte-identical proofs, so A's proof is a
  valid proof for B. Those pairs are left out of the file.
- Structural mutations, re-hashed up to a new root so every hash still matches, test
  `Malformed` and `BadReference`:
  - `node-3-items`, `node-is-string`, `branch-16-items` and `branch-18-items` give an
    invalid node shape
  - `hp-bad-flag`, `hp-nonzero-pad`, `hp-bad-flag-ext` and `hp-nonzero-pad-ext` give an
    invalid hex-prefix path
  - `leaf-ends-early`, `leaf-ends-late`, `ext-reaches-64` and `ext-empty-path` break a
    depth rule
  - `branch-ref-{20,31,33}` and `ext-ref-{31,33,empty}` give a child reference of the
    wrong length
  - `embed-large-node` embeds a 32 B or 68 B node as a list
  - `rlp-len-5-bytes` and `rlp-len-8-bytes` write a node's long-form length in 5 or 8
    bytes whose low 32 bits are the true length (`fc 01 00 00 00 44 …`): a verifier
    that keeps lengths in a 32-bit integer reads them as valid. Expected: `Malformed`.
  - `value-leading-zero` and `value-zero-byte` store a value that is not a canonical
    integer (`0x00` before the value, or zero as the byte `0x00`). Expected: `Malformed`;
    `verifyProof` does not decode values and accepts them.
- `empty-root/with-node` applies the rules literally: any entry must hash to the root.
  Expected: `HashMismatch`.

**Embedded nodes in a secure trie.** A leaf is embedded only if its RLP is under
32 bytes. With 64-nibble paths that needs depth ≥ 9 and a single-byte stored value.
Leaves at depth 7–8 with a 1-byte value are exactly 32 B and are hashed.

Depth 9 needs two keys whose hashes share their first 8 nibbles. A random trie of
practical size essentially never contains such a pair: the expected count is about
N²/2³³. So `gen.mjs` searches sequential slot keys (birthday search, ~336k keccaks)
for pairs whose hashes share a 32-bit prefix, and for pairs sharing exactly a 28-bit
prefix (the boundary cases). It plants those pairs in tries of 2, 108 and 5024 keys
with small values. It then walks the proofs and keeps only those that really pass
through an RLP-list branch child.

An embedded branch or extension would need about 56 shared nibbles, which no search
can produce. So every embedded node on a secure-trie path is the final leaf.
