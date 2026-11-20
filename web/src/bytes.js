// Bytes for the drawing: Keccak-256 and just enough RLP to find a node's
// items, so the page can show which slot each branch takes and the hash each
// node must have. Verdicts never come from here: they come from
// ferrotype.wasm and from the contract.

const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n,
  0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn,
  0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an,
  0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64 : v);

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= D;
    }
    const B = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & M64 & B[((x + 2) % 5) + y]);
    s[0] ^= RC[r];
  }
}

/** Keccak-256 of `bytes`, as 64 hex digits (no 0x). */
export function keccak(bytes) {
  const R = 136, n = bytes.length, p = new Uint8Array(Math.floor(n / R + 1) * R);
  p.set(bytes);
  p[n] ^= 1;
  p[p.length - 1] ^= 0x80;
  const s = Array(25).fill(0n);
  for (let o = 0; o < p.length; o += R) {
    for (let i = 0; i < 17; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(p[o + 8 * i + b]);
      s[i] ^= v;
    }
    keccakF(s);
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    let v = s[i];
    for (let b = 0; b < 8; b++) {
      out += Number(v & 0xffn).toString(16).padStart(2, "0");
      v >>= 8n;
    }
  }
  return out;
}

export const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);

export function fromHex(h) {
  h = strip(h);
  if (h.length % 2) h = "0" + h;
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(2 * i, 2), 16);
  return o;
}

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The items of an RLP list, as `{ off, len }` ranges of `b` (payload only for strings, whole item for lists). */
export function rlpItems(b) {
  let p, end;
  if (b[0] >= 0xf8) {
    const ll = b[0] - 0xf7;
    let L = 0;
    for (let i = 0; i < ll; i++) L = L * 256 + b[1 + i];
    p = 1 + ll;
    end = p + L;
  } else {
    p = 1;
    end = 1 + b[0] - 0xc0;
  }
  const items = [];
  while (p < end && p < b.length) {
    const x = b[p];
    let off, len;
    if (x < 0x80) { off = p; len = 1; p += 1; }
    else if (x <= 0xb7) { off = p + 1; len = x - 0x80; p = off + len; }
    else if (x < 0xc0) {
      const ll = x - 0xb7;
      len = 0;
      for (let i = 0; i < ll; i++) len = len * 256 + b[p + 1 + i];
      off = p + 1 + ll;
      p = off + len;
    } else if (x <= 0xf7) { off = p; len = 1 + x - 0xc0; p += len; }
    else {
      const ll = x - 0xf7;
      let L = 0;
      for (let i = 0; i < ll; i++) L = L * 256 + b[p + 1 + i];
      off = p;
      len = 1 + ll + L;
      p += len;
    }
    items.push({ off, len });
  }
  return items;
}

// ---- words and numbers, for people ------------------------------------------

export const grp = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const h8 = (h) => strip(h).slice(0, 8);
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const wordShort = (w) => {
  const s = strip(w).padStart(64, "0");
  const tail = s.replace(/^0+/, "");
  return tail.length <= 14 ? "0x" + (tail || "0") : "0x" + s.slice(0, 4) + "…" + s.slice(-10);
};

/** `v` (base units) with `dec` decimals, grouped: 52,363.119552. */
export function units(v, dec) {
  if (!dec) return grp(v.toString());
  const s = v.toString().padStart(dec + 1, "0");
  const frac = s.slice(-dec).replace(/0+$/, "");
  return grp(s.slice(0, -dec)) + (frac ? "." + frac : "");
}

export function eth2(v) {
  if (v === 0n) return "0 ETH";
  const s = v.toString().padStart(19, "0");
  return `${grp(s.slice(0, -18))}.${s.slice(-18, -16)} ETH`;
}
