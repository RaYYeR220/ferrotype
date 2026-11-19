// A host for ferrotype.wasm, for browsers and Node.js (no dependencies).
//
// The module exports the Fe verifier (wasm/exports.fe). Every argument is hex
// text placed in the module's memory; a successful reply carries the address
// of a record of 32-byte big-endian words, read here before the arena that
// holds it is released.

export const PROOF_ERRORS = Object.freeze({
  1: "Malformed",
  2: "HashMismatch",
  3: "MissingNode",
  4: "ExtraNodes",
  5: "BadReference",
  20: "BadHex",
  21: "BadHeader",
});

export class ProofRejected extends Error {
  constructor(code) {
    super(`proof rejected: ${PROOF_ERRORS[code] ?? `error ${code}`}`);
    this.name = "ProofRejected";
    this.code = code;
    this.reason = PROOF_ERRORS[code] ?? `error ${code}`;
  }
}

const encoder = new TextEncoder();

function hexWord(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function strip(hex) {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** Instantiates the module from its bytes. */
export async function loadFerrotype(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;

  // Calls export `name` with `args` (strings become texts, numbers stay
  // scalars) and reads `words` words of the record it replies with. `words`
  // may be a function of the record's first words, for records whose length
  // they state.
  function call(name, words, ...args) {
    const mark = ex.arena_mark();
    try {
      const flat = [];
      for (const arg of args) {
        if (typeof arg === "number") {
          flat.push(arg);
          continue;
        }
        const text = encoder.encode(arg);
        const addr = ex.alloc(text.length);
        new Uint8Array(ex.memory.buffer, addr, text.length).set(text);
        flat.push(addr, text.length);
      }
      const reply = BigInt.asUintN(64, BigInt(ex[name](...flat)));
      const tag = Number(reply & 0xffffffffn);
      const payload = Number(reply >> 32n);
      if (tag !== 0) throw new ProofRejected(tag);
      const mem = new Uint8Array(ex.memory.buffer);
      const word = (i) => hexWord(mem.subarray(payload + i * 32, payload + (i + 1) * 32));
      const count = typeof words === "function" ? words(word) : words;
      const out = [];
      for (let i = 0; i < count; i++) out.push(word(i));
      return out;
    } finally {
      ex.arena_release(mark);
    }
  }

  const join = (nodes) => nodes.map(strip).join("");

  return {
    /** Proves `slot` of `account` under `stateRoot` with eth_getProof's node lists. */
    readStorage({ stateRoot, account, slot, accountProof, storageProof }) {
      const [value, storageRoot, balance, nonce, exists] = call(
        "read_storage",
        5,
        stateRoot,
        account,
        slot,
        join(accountProof),
        join(storageProof),
      );
      return { value, storageRoot, balance, nonce, exists: BigInt(exists) === 1n };
    },

    /**
     * `readStorage`, plus the verifier's own steps: every node it accepted, in
     * order, as `{ trie: "state" | "storage", depth, offset, length, kind, inline }`.
     */
    traceStorage({ stateRoot, account, slot, accountProof, storageProof }) {
      const words = call(
        "trace_storage",
        (word) => 6 + 6 * Number(BigInt(word(5))),
        stateRoot,
        account,
        slot,
        join(accountProof),
        join(storageProof),
      );
      const [value, storageRoot, balance, nonce, exists, count] = words;
      const kinds = ["branch", "extension", "leaf"];
      const steps = [];
      for (let i = 0; i < Number(BigInt(count)); i++) {
        const [trie, depth, offset, length, kind, inline] = words.slice(6 + 6 * i, 12 + 6 * i).map((w) => Number(BigInt(w)));
        steps.push({ trie: trie === 0 ? "state" : "storage", depth, offset, length, kind: kinds[kind], inline: inline === 1 });
      }
      return { value, storageRoot, balance, nonce, exists: BigInt(exists) === 1n, steps };
    },

    /** Decodes an RLP block header and hashes it. */
    readHeader(headerHex) {
      const [hash, stateRoot, number, timestamp] = call("read_header", 4, headerHex);
      return { hash, stateRoot, number: BigInt(number), timestamp: BigInt(timestamp) };
    },

    /** Looks a hashed key up in a trie: `{ found, value }`. */
    lookup(root, path, nodes) {
      const [verdict, value] = call("lookup", 2, root, path, join(nodes));
      return { found: BigInt(verdict) === 0n, value };
    },

    /** The storage slot of `holder`'s balance under a token's layout (0 Solidity, 1 Vyper, 2 flagged). */
    balanceSlot(layout, base, holder) {
      return call("balance_slot", 1, layout, base, holder)[0];
    },
  };
}
