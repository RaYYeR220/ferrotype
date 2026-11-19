// Runs every proof vector and every mainnet fixture through ferrotype.wasm
// and checks each verdict, so the WebAssembly build is held to the same
// expectations as the EVM and native builds.
//
//   node wasm/check.mjs web/public/ferrotype.wasm
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFerrotype, ProofRejected } from "../web/src/ferrotype.js";
import { encodeHeader } from "../web/src/header.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasm = process.argv[2] ?? path.join(root, "web/public/ferrotype.wasm");
const fe = await loadFerrotype(fs.readFileSync(wasm));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

for (const group of ["inclusion", "inline", "exclusion", "invalid"]) {
  const cases = JSON.parse(fs.readFileSync(path.join(root, "fixtures/synthetic", `${group}.json`)));
  for (const c of cases) {
    let verdict;
    try {
      const r = fe.lookup(c.root, c.path, c.proof);
      verdict = r.found ? { found: true, value: BigInt(r.value) } : { found: false };
    } catch (e) {
      if (!(e instanceof ProofRejected)) throw e;
      verdict = { error: e.reason };
    }
    const want = c.expect;
    const ok =
      "error" in want
        ? verdict.error === want.error
        : want.found
          ? verdict.found === true && verdict.value === BigInt(want.word)
          : verdict.found === false;
    check(c.name, ok, JSON.stringify({ want, got: verdict }, (_, v) => (typeof v === "bigint" ? v.toString(16) : v)));
  }
}

for (const file of fs.readdirSync(path.join(root, "fixtures/mainnet"))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, "fixtures/mainnet", file)));
  const header = fe.readHeader(encodeHeader(d.block));
  check(`${file} header hash`, header.hash === d.block.hash);
  check(`${file} state root`, header.stateRoot === d.block.stateRoot);
  for (const s of d.proof.storageProof) {
    const r = fe.readStorage({
      stateRoot: header.stateRoot,
      account: d.proof.address,
      slot: s.key,
      accountProof: d.proof.accountProof,
      storageProof: s.proof,
    });
    check(`${file} slot ${s.key.slice(0, 10)}`, BigInt(r.value) === BigInt(s.value));
    check(`${file} balance`, BigInt(r.balance) === BigInt(d.proof.balance));
  }
}

console.log(`wasm: ${pass} passed; ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
