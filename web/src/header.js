// RLP-encodes a block header from the fields eth_getBlockByNumber returns.
// The Fe verifier then hashes it; a header is only trusted if that hash is the
// block hash the chain reports.

const FIELDS = [
  ["parentHash", "bytes"], ["sha3Uncles", "bytes"], ["miner", "bytes"], ["stateRoot", "bytes"],
  ["transactionsRoot", "bytes"], ["receiptsRoot", "bytes"], ["logsBloom", "bytes"],
  ["difficulty", "int"], ["number", "int"], ["gasLimit", "int"], ["gasUsed", "int"],
  ["timestamp", "int"], ["extraData", "bytes"], ["mixHash", "bytes"], ["nonce", "bytes"],
  ["baseFeePerGas", "int"], ["withdrawalsRoot", "bytes"], ["blobGasUsed", "int"],
  ["excessBlobGas", "int"], ["parentBeaconBlockRoot", "bytes"], ["requestsHash", "bytes"],
];

function fromHex(hex) {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function quantity(hex) {
  let s = (hex.startsWith("0x") ? hex.slice(2) : hex).replace(/^0+/, "");
  if (s.length % 2) s = "0" + s;
  return fromHex(s);
}

function length(n, offset) {
  if (n < 56) return [offset + n];
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [offset + 55 + bytes.length, ...bytes];
}

function item(bytes) {
  if (bytes.length === 1 && bytes[0] < 0x80) return [...bytes];
  return [...length(bytes.length, 0x80), ...bytes];
}

/** The header's RLP encoding as 0x-hex. */
export function encodeHeader(block) {
  const payload = [];
  for (const [name, kind] of FIELDS) {
    if (!(name in block) || block[name] == null) break;
    payload.push(...item(kind === "int" ? quantity(block[name]) : fromHex(block[name])));
  }
  const all = [...length(payload.length, 0xc0), ...payload];
  return "0x" + all.map((b) => b.toString(16).padStart(2, "0")).join("");
}
