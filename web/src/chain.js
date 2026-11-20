// Talking to Ethereum from the browser, with no dependencies: JSON-RPC over
// fetch, the proofs a read needs, and the calldata of the two contract views
// the page uses. Nothing here decides whether a proof is valid; the Fe
// verifier (ferrotype.wasm) and the contracts do.

import { encodeHeader } from "./header.js";

// Free public endpoints, all of which send `access-control-allow-origin: *`.
// They answer eth_getProof only for recent blocks (publicnode on Sepolia only
// at the head, Tenderly for roughly the last 60 to 100); an archive node
// answers for any block.
export const NETWORKS = Object.freeze({
  mainnet: { name: "Ethereum", chainId: 1, rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  sepolia: {
    name: "Sepolia", chainId: 11155111, rpc: "https://sepolia.gateway.tenderly.co",
    fallback: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
  },
});

let nextId = 1;

/** One JSON-RPC call. Throws with the node's message on error. */
export async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) {
    const error = new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    error.data = body.error.data;
    error.code = body.error.code; // the node answered: this is not a transport failure
    throw error;
  }
  return body.result;
}

const quantity = (n) => "0x" + BigInt(n).toString(16);
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);

/**
 * Everything one read needs at one block: the header (RLP, for the Fe
 * verifier to hash) and eth_getProof for `account` and `slot`. `proof` is the
 * node's whole answer, kept so the read can be saved in the `{ block, proof }`
 * file `ferrotype verify` takes.
 */
export async function fetchRead(url, { account, slot, block = "latest" }) {
  const tag = block === "latest" ? "latest" : quantity(block);
  const header = await rpc(url, "eth_getBlockByNumber", [tag, false]);
  if (!header) throw new Error(`the node does not know block ${block}`);
  const proof = await rpc(url, "eth_getProof", [account, [word(slot)], header.number]);
  if (!proof || !Array.isArray(proof.accountProof) || !proof.storageProof?.[0]) throw new Error("eth_getProof: the answer has no proof in it");
  return {
    block: header,
    headerRlp: encodeHeader(header),
    account: proof.address,
    slot: word(slot),
    claimed: proof.storageProof[0].value,
    accountProof: proof.accountProof,
    storageProof: proof.storageProof[0].proof,
    proof,
  };
}

/** A copy of `nodes` with one bit of byte `index` (counted across all nodes) flipped. */
export function flipByte(nodes, index, bit = 0) {
  const out = nodes.slice();
  let at = index;
  for (let i = 0; i < out.length; i++) {
    const bytes = strip(out[i]).length / 2;
    if (at < bytes) {
      const hex = strip(out[i]);
      const b = parseInt(hex.slice(2 * at, 2 * at + 2), 16) ^ (1 << bit);
      out[i] = "0x" + hex.slice(0, 2 * at) + b.toString(16).padStart(2, "0") + hex.slice(2 * at + 2);
      return out;
    }
    at -= bytes;
  }
  throw new Error("flipByte: index past the end of the proof");
}

// ---- ABI ----------------------------------------------------------------------

function encodeBytes(hex) {
  const body = strip(hex);
  const len = body.length / 2;
  const padded = body.padEnd(Math.ceil(len / 32) * 64, "0");
  return strip(word(len)) + padded;
}

/** Heads and tails for a tuple of `word` (static) and `bytes` (dynamic) values. */
function encodeTuple(values) {
  const heads = [];
  const tails = [];
  let offset = values.length * 32;
  for (const v of values) {
    if (v.bytes !== undefined) {
      heads.push(strip(word(offset)));
      const tail = encodeBytes(v.bytes);
      tails.push(tail);
      offset += tail.length / 2;
    } else {
      heads.push(strip(word(v.word)));
    }
  }
  return heads.join("") + tails.join("");
}

const join = (nodes) => "0x" + nodes.map(strip).join("");

/** StateReader.storageAtPacked(bytes32 stateRoot, address account, bytes32 slot, bytes accountProof, bytes storageProof) */
export function storageAtPackedCall({ stateRoot, account, slot, accountProof, storageProof }) {
  return (
    "0xfe3242a8" +
    encodeTuple([
      { word: stateRoot },
      { word: account },
      { word: slot },
      { bytes: join(accountProof) },
      { bytes: join(storageProof) },
    ])
  );
}

/** Plebiscite.votingPower(uint256 id, address holder, bytes balanceProof) */
export function votingPowerCall({ id, holder, balanceProof }) {
  return "0x08e038f3" + encodeTuple([{ word: id }, { word: holder }, { bytes: join(balanceProof) }]);
}

/** Plebiscite.snapshot(uint256 id) → (block, storageRoot, supply) */
export function snapshotCall(id) {
  return "0x8f1dd809" + strip(word(id));
}

/** Plebiscite.tally(uint256 id) → (votesFor, votesAgainst, supply, deadline, snapshotBlock, executed) */
export function tallyCall(id) {
  return "0xed8b6b31" + strip(word(id));
}

/** Plebiscite.config() → (token, layoutKind, balanceSlot, supplySlot, votingPeriod, quorumBps, maxSnapshotAge) */
export const CONFIG_CALL = "0x79502c55";

const ERRORS = {
  f7f9ec62: ["InvalidProof", ["Malformed", "HashMismatch", "MissingNode", "ExtraNodes", "BadReference"]],
  bd5adfec: [
    "Refused",
    ["UnknownProposal", "VotingClosed", "VotingOpen", "AlreadyVoted", "NoWeight", "FlaggedHolder", "NotPassed",
      "AlreadyExecuted", "WrongCalldata", "UnknownBlock", "BadHeader", "CallFailed"],
  ],
};

/** Decodes a contract's revert data into `{ error, reason }`, if it is one of ours. */
export function decodeRevert(data) {
  const hex = strip(data ?? "");
  const known = ERRORS[hex.slice(0, 8)];
  if (!known) return null;
  const code = Number(BigInt("0x" + (hex.slice(8, 72) || "0")));
  return { error: known[0], reason: known[1][code - 1] ?? `code ${code}` };
}

/**
 * eth_call; resolves to `{ ok: true, words }` or `{ ok: false, revert }`
 * with the decoded revert reason when the contract refuses. `transport` is
 * set when no node answered at all (network, CORS, HTTP status).
 */
export async function view(url, to, data) {
  const t0 = performance.now();
  try {
    const result = await rpc(url, "eth_call", [{ to, data }, "latest"]);
    const body = strip(result);
    const words = [];
    for (let i = 0; i < body.length; i += 64) words.push("0x" + body.slice(i, i + 64));
    return { ok: true, words, url, ms: performance.now() - t0 };
  } catch (e) {
    const data = typeof e.data === "string" ? e.data : e.data?.data;
    return { ok: false, revert: decodeRevert(data), message: String(e.message), transport: e.code === undefined, url, ms: performance.now() - t0 };
  }
}

/** `view` on the first of `urls` that answers; a revert is an answer. */
export async function viewAny(urls, to, data) {
  let last;
  for (const url of urls) {
    last = await view(url, to, data);
    if (!last.transport) return last;
  }
  return last;
}
