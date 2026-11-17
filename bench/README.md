# Ferrotype gas bench

This bench measures what it costs to read one storage slot of a mainnet contract from a state root. The account proof is checked against the block's state root, the account's storage root is taken from it, and the storage proof is checked against that root. Every verifier runs on the same real `eth_getProof` responses and must return the slot's value. If any verifier returns a wrong value, or rejects a valid proof it is built to handle, the run fails.

| Verifier | Source | solc |
|---|---|---|
| Ferrotype (Fe), `storageAt` and `storageAtPacked` | `../out/StateReader.bin` | Fe |
| Optimism Bedrock `SecureMerkleTrie` + `RLPReader` | `op-contracts/v9.0.0` | 0.8.37 |
| Lido `StateProofVerifier` + `MerklePatriciaProofVerifier`, as audited | `1033b3e`, with Solidity-RLP 2.0.5 | 0.6.12 |
| The same Lido code, Curve's 0.8 port | `curvefi/curve-merkle-oracle@b395fb2` | 0.8.37 |

All Solidity builds use the optimizer at 200 runs, no via-IR, and `evm_version = "osaka"`. Each solc version comes from the wrapper's exact pragma. 0.8.37 is the newest release forge 1.8.3 can resolve. 0.6.12 is the compiler Lido shipped and audited. Commits, licenses and checksums for the vendored code are in [`vendor/README.md`](vendor/README.md).

## Run

```sh
cd bench
forge test -vv        # asserts every value, prints a line per call, writes results/*.json
python render.py      # results/gas.json + results/soundness.json -> results/gas.md
```

You need forge (tested with 1.8.3) and Python 3. On first run, forge downloads solc 0.8.37 and 0.6.12. The bench has no dependencies: `test/utils/Vm.sol` declares the few cheatcodes it uses, so it does not need forge-std.

The Fe rows come from `../out/StateReader.bin`, which holds hex init code. Build it from the `ferrotype/` directory with `fe build ingots/contracts --out-dir out`. If the file is missing, the Fe rows show as `skipped` and everything else still runs.

## Cases

| Case | Fixture | What it exercises |
|---|---|---|
| `usdc-blacklisted-holder` | `usdc.json`, key 0 | Inclusion. The slot's top bit is USDC's blacklist flag. The raw word is returned. |
| `usdc-holder` | `usdc.json`, key 1 | Inclusion, a plain balance. |
| `weth-zero-slot` | `weth.json` | The slot is 0, so the storage proof proves absence. |
| `absent-account` | `absent-account.json` | The account does not exist, so the state proof proves absence. The account counts as empty and the slot is 0. |
| `eoa-empty-storage` | `eoa-empty-storage.json` | An EOA with the empty storage root and an empty storage proof. |

`test_rejectsInvalidProofs` also breaks the `usdc-holder` proof four ways: a wrong state root, a tampered leaf, a truncated storage proof, and a truncated account proof sent with no storage proof. It records whether each verifier rejects each broken proof.

## What is measured

- **`execution_gas`**: gas spent inside the verifier. The test calls the verifier twice with `STATICCALL` and measures the second call, so the target is warm, as a transaction's own `to` is. It then subtracts the same call made to an address with no code. What remains is `gasUsed − 21,000 − calldata gas` for a transaction that makes the same call. On anvil (osaka), real transactions for the Fe and Lido rows of `usdc-holder` used 475,805 and 485,611 gas. Both match `tx_gas` exactly.
- **`calldata_bytes`** and **`calldata_gas`**: the full ABI-encoded call, priced at 16 gas per nonzero byte and 4 per zero byte.
- **`tx_gas`**: 21,000 + max(calldata gas + execution gas, EIP-7623 floor). The floor is 10 gas per token, and it never binds for these calls.

The wrappers in `src/` give Optimism and Lido the same `storageAt(bytes32,address,bytes32,bytes[],bytes[])` interface that Ferrotype exposes. Each wrapper uses its library's own API.

## Reading the results

[`results/gas.md`](results/gas.md) has the tables. A few things that are not obvious from the numbers alone:

- **Optimism proves inclusion only.** `MerkleTrie.get` reverts on every exclusion proof. That covers a zero slot, an absent account, and an empty storage trie, so those rows read `unsupported`, with the library's revert reason.
- **Lido's two builds differ only in the compiler.** Both builds run the same source. On `usdc-holder` the 0.8 build costs 572,921 gas against 344,979 on 0.6.12. Built with solc 0.7.6, the same 0.8 port costs 344,212, so the gap is 0.8's checked arithmetic.
- **Lido's verifier accepts truncated proofs.** If a proof stops right after a branch node, `MerklePatriciaProofVerifier.extractProofValue` runs out of nodes and returns empty bytes. `StateProofVerifier` reads that as "absent", so the slot reads as 0 or the account as nonexistent. Both builds behave this way, and the soundness test pins it. Curve's later copy of this library in `curvefi/curve-xdao` adds an explicit `NoChild` revert for this case. Optimism and Ferrotype reject both truncations.
- **Packed calldata trades execution for bytes.** `storageAtPacked` drops the ABI offsets and lengths. On `usdc-holder` that saves 1,280 bytes and 5,840 calldata gas. It spends 1,943 more gas walking the nodes, so the full transaction comes out 3,897 gas cheaper.
