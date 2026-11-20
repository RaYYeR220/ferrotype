# Reviewing Ferrotype in five minutes

**Fastest look, nothing to install:** open [ferrotype.vercel.app/try](https://ferrotype.vercel.app/try). One saved mainnet read runs in your browser through `ferrotype.wasm` and through the `StateReader` contract on Sepolia (`eth_call`), next to the native CLI's recorded output on the same file (its sha256 is checked in the page, and the file can be downloaded and run). Damage the proof with the buttons, or click any node to flip a byte, and watch every runtime refuse. Further down, both Plebiscites answer voting-power questions live. Then come back here to reproduce everything yourself.

## 1. Run everything (one command)

```sh
docker build -t ferrotype . && docker run --rm ferrotype
```

This installs Fe 26.6.0 from its release and Foundry, builds the contracts, the CLI and the fuzzer, then runs every check. The end of the output should read:

```
== EVM
test result: ok. 369 passed; 0 failed
== native
test result: ok. 352 passed; 0 failed
== WebAssembly
wasm: 351 passed; 0 failed
== fuzz (native)
true      679 still prove the true value
rejected  999321
wrong     0
== gas benchmark
Suite result: ok. 2 passed; 0 failed; 0 skipped
== end to end on http://127.0.0.1:8545
end to end: all checks passed
```

Without Docker: `fe test ingots/conformance` and, on x86-64 Linux or AArch64 macOS, `fe test --backend native ingots/conformance`.

## 2. Read the Fe that matters, in this order

| File | What to look for |
|---|---|
| [`ingots/ferrotype/src/trie.fe`](ingots/ferrotype/src/trie.fe) | `lookup`: the whole Merkle-Patricia walk in one function, presence and absence, embedded nodes, five rejection reasons, no node ever copied |
| [`ingots/ferrotype/src/rlp.fe`](ingots/ferrotype/src/rlp.fe) | `branch_child`: a branch decoded in one pass with fast paths for hash and empty children (the change that halved the gas) |
| [`ingots/ferrotype/src/state.fe`](ingots/ferrotype/src/state.fe) | `BlockHash`, `StateRoot`, `StorageRoot`: a proof cannot be checked against the wrong trie; `EMPTY_CODE_HASH` computed by the compiler |
| [`ingots/ferrotype/src/hash.fe`](ingots/ferrotype/src/hash.fe) | the only target-specific code in the library: three `#[cfg(target = ...)]` Keccak functions |
| [`ingots/contracts/src/plebiscite.fe`](ingots/contracts/src/plebiscite.fe) | the `uses` clauses: only `Execute` holds `mut call`; `Propose` can only `STATICCALL` |
| [`ingots/contracts/src/ballot.fe`](ingots/contracts/src/ballot.fe) | the ledger as library functions over a storage effect, with the clock passed in so tests can move it |
| [`ingots/cli/src/lib.fe`](ingots/cli/src/lib.fe) | `calldata`: the CLI encodes the contracts' own `msg` types; `prove_slot` checks every node answer before printing |

## 3. Check the numbers

- Gas: [`bench/results/gas.md`](bench/results/gas.md), produced by `cd bench && forge test && python3 render.py` from the same mainnet proofs for all five verifiers.
- Tests and fuzzing: [`results/tests.json`](results/tests.json), written by `scripts/test.sh`.
- Every number in the README is rendered from those two files by `scripts/render_readme.py`.

## 4. Try it against a live chain

```sh
scripts/build.sh
target/bin/ferrotype balance --rpc https://ethereum-rpc.publicnode.com \
  --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --holder 0x28C6c06298d514Db089934071355E5743bf21d60 --layout flagged --slot 9
```

It fetches the latest header and the proofs, rebuilds the header and checks its hash, proves the account and the slot, and reports the balance and USDC's blacklist flag. Sepolia already runs the Amsterdam fork, whose headers carry two more fields; `--rpc https://ethereum-sepolia-rpc.publicnode.com` works too.

The contracts deployed on Sepolia answer with `eth_call`, so checking them needs no key and no funds (Python 3, standard library only):

```sh
python3 scripts/check_live.py
```

It asks `StateReader` to prove the five saved mainnet reads against their state roots and to refuse them with a node missing or a bit flipped, asks both Plebiscites for the voting power of every voter whose proof was saved at the snapshot block (`deployments/sepolia-snapshots.json`) and to refuse one voter's proof sent for another, and reads the demo proposal's tally (700 for, 300 against, from balances that are 100 and 600 today). The addresses and every transaction of the governance run are in the README's "Live on Sepolia" section.

## 5. Try to break it

- Change one byte of a proof in `fixtures/mainnet/usdc.json` and run `target/bin/ferrotype verify fixtures/mainnet/usdc.json`: the proof is rejected with a reason.
- `target/fuzz/fuzz 100000 7` damages proofs with your own seed; `wrong` must stay 0.
- In `ingots/ferrotype/src/trie.fe`, change the reference value in the `static_assert` next to `EMPTY_TRIE_ROOT`: the library stops compiling.
- In `ingots/contracts/src/plebiscite.fe`, remove `call` from `Execute`'s `uses` clause, or call `pay` from `Vote`: neither compiles (`missing effect Call required by pay`).

## 6. Where each judging criterion is answered

| Criterion | Where to look |
|---|---|
| Technical quality | the library tests on three targets and the generated vectors (README "Results", which says what each target runs); a million damaged proofs with no wrong value; a clean container and CI that build and test everything from scratch (section 1); the gas benchmark against the audited verifiers; the soundness table |
| Fe-specific value | one library for the EVM, native code and WebAssembly, with `#[cfg(target)]` only in `hash.fe`; `recv` arms whose `uses` clauses show that only `Execute` can move funds; constants computed and checked at compile time (`static_assert`); the trace observer gated by an associated constant so it costs nothing when unused; CLI calldata encoded from the contracts' own `msg` types; the compiler gap reported upstream (argotorg/fe#2047). README "Fe highlight" and "Which abstractions are free" |
| Originality | governance weighted by any ERC-20's balances at a past block, read from the token's own storage, so a token without checkpoints (USDC, CRV) needs nothing from its issuer; the same verifier answering in the contract, the CLI and the browser side by side |
| Usefulness and insight | the gas numbers; the reproduction of the early-ending-proof bug class against Lido's and Curve's verifiers; what `@ethereumjs/trie` accepts; Amsterdam headers on Sepolia; how little proof history free public nodes keep (README "Limitations") |
| Documentation and demo | the README, this guide, [`CLAIMS.md`](CLAIMS.md), the [live demo](https://ferrotype.vercel.app/try) and `scripts/check_live.py` |
