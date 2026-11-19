# Reviewing Ferrotype in five minutes

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

## 5. Try to break it

- Change one byte of a proof in `fixtures/mainnet/usdc.json` and run `target/bin/ferrotype verify fixtures/mainnet/usdc.json`: the proof is rejected with a reason.
- `target/fuzz/fuzz 100000 7` damages proofs with your own seed; `wrong` must stay 0.
- In `ingots/ferrotype/src/trie.fe`, change the reference value in the `static_assert` next to `EMPTY_TRIE_ROOT`: the library stops compiling.
- In `ingots/contracts/src/plebiscite.fe`, remove `call` from `Execute`'s `uses` clause, or call `pay` from `Vote`: neither compiles (`missing effect Call required by pay`).
