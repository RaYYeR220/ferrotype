# Ferrotype

**Pitch:** Ferrotype lets a contract read any other contract's storage at a past block, trustlessly, for <!-- n:fe_gas -->177,758<!-- /n --> gas — <!-- n:vs_lido -->48%<!-- /n --> less than Lido's audited verifier and <!-- n:vs_op -->65%<!-- /n --> less than Optimism's — with one Fe codebase that runs on-chain, in a native CLI and in the browser.

A DAO wants USDC holders to vote on its treasury. USDC has no checkpoints and never will: no one upgrades a $75B token for one DAO. Today the answer is an off-chain snapshot server that everyone has to trust. With Ferrotype the DAO reads each voter's balance straight out of USDC's storage at the proposal's block, proven against the block hash the chain itself remembers. The token cooperates without knowing it.

## The problem

Every contract's storage is committed to by the block header, through two Merkle-Patricia tries: the state trie holds the account, the account's storage trie holds the slot. So any contract could, in principle, read any other contract's state at any recent block, from a proof. In practice:

- The machinery is missing in Fe. The Fe team's own words: *"Merkle-Patricia proofs of another contract's storage: the precompiles are wrapped in std, but most of the machinery around them is still waiting to be written."*
- The Solidity machinery is expensive or incomplete. Optimism's audited `MerkleTrie` cannot prove that a slot is empty, so a zero balance or a missing account cannot be read at all. Lido's audited `StateProofVerifier` proves absence, but accepts a proof whose node list stops early after a branch node, reading the slot as zero. Both copy every node into fresh memory before decoding it.
- The off-chain half is written twice. The tool that fetches proofs from a node, the keeper that submits them and the UI that previews them each reimplement the verifier in another language, and the copies drift apart.

## Approach

One library, written once in Fe, compiled three ways:

| Runtime | What runs | Built with |
|---|---|---|
| EVM | `StateReader` (read any slot, given a state root) and `Plebiscite` (a treasury governed by any ERC-20's holders) | `fe build -O 2` |
| Native | `ferrotype`, a CLI that talks to an Ethereum node, proves every value before printing it, and prints the calldata the contracts accept | `fe build --backend native` |
| WebAssembly | the verifier in the browser: a page checks a proof before a wallet ever sees it | `fe build --backend wasm` |

The verifier ([`trie.fe`](ingots/ferrotype/src/trie.fe), [`rlp.fe`](ingots/ferrotype/src/rlp.fe)) walks a proof in place. All nodes live in one buffer; every node and every embedded child is a range of it. Nothing is copied, no item list is allocated, and a branch node is decoded in a single pass with fast paths for the two headers almost every child has (a 32-byte hash, or empty). It proves presence and absence (an empty branch slot, or a leaf or extension whose path diverges), follows embedded nodes, and rejects everything else with a reason: `Malformed`, `HashMismatch`, `MissingNode`, `ExtraNodes`, `BadReference`. Only canonical RLP is accepted.

On top of it, [`state.fe`](ingots/ferrotype/src/state.fe) decodes block headers of every fork (one decoder: every fork keeps the first fifteen fields) and proves accounts and slots, and [`slots.fe`](ingots/ferrotype/src/slots.fe) knows where Solidity and Vyper put mappings and how tokens pack balances, including USDC's blacklist bit.

[`Plebiscite`](ingots/contracts/src/plebiscite.fe) uses all of it. Opening a proposal anchors it to a block the chain still remembers: the header must hash to `BLOCKHASH` (or the EIP-2935 history contract), its state root proves the token's account, and the account's storage root is kept. From then on a vote needs one short storage proof, of the voter's own balance slot. Balances are counted at the snapshot block, so tokens moved after it vote nowhere twice; a holder the token flags (USDC's blacklist) cannot vote; quorum is a share of the total supply proven at the same block.

Everything here was written during the contest (see [Declaration](#declaration)).

## Fe highlight

**The same function proves a slot in a contract, in a native program and in a browser, and the compiler shows which code can move money.**

The verifier is ordinary Fe over a byte span. The only target-specific lines in the library are the three Keccak functions in [`hash.fe`](ingots/ferrotype/src/hash.fe), chosen with `#[cfg]`: the `KECCAK256` instruction on the EVM, `core::hash` elsewhere.

```fe
#[cfg(target = "evm")]
pub fn keccak(_ data: MemSpan) -> u256 {
    std::evm::keccak256(data)
}

#[cfg(target = "native")]
pub fn keccak(_ data: MemSpan) -> u256 {
    core::hash::keccak256_word(data)
}
```

The capabilities of every handler are in its signature, checked by the compiler. In `Plebiscite`, only `Execute` holds `mut call`, the capability to send value or make a state-changing call. `Propose` holds `call` read-only, which allows nothing but `STATICCALL` (to read old block hashes from the EIP-2935 contract):

```fe
Propose { header, token_proof, supply_proof, target, value, data } -> u256
    uses (ctx, call, token, supply_slot, voting_period, max_snapshot_age, mut ledger, mut log)
Vote { id, support, balance_proof } -> u256 uses (ctx, layout_kind, balance_slot, mut ledger, mut log)
Execute { id, data } -> bool uses (ctx, mut call, quorum_bps, mut ledger, mut log)
```

And the trie roots are types, so a proof cannot be checked against the wrong trie:

```fe
pub fn storage<N: Nodes>(_ buf: MemSpan, nodes: mut N, root: StorageRoot, slot: u256) -> Result<ProofError, u256>
```

`state::storage(.., root: header.state_root, ..)` does not compile: a `StateRoot` is not a `StorageRoot`, and the only way to get one is to prove an account.

More Fe that carries weight here:
- The CLI encodes calldata from the contracts' own `msg` types (`<M as MsgVariant<Sol>>::SELECTOR` and the std ABI encoder), so its output cannot drift from what the contracts decode.
- Its network access is a capability too: `rpc::call` `uses (proc: mut Spawn)` and runs `curl`; nothing that does not declare `Spawn` can reach the network.
- `Wei` and `Timestamp` keep amounts and deadlines apart in the ballot; the compiler checks every `sol(...)` selector against its fields' ABI types.

## Architecture

```
                          ingots/ferrotype (library, no unsafe)
   +--------------------------------------------------------------------------+
   | rlp.fe    canonical RLP, read in place                                   |
   | trie.fe   Merkle-Patricia lookup: present / absent / rejected (5 reasons) |
   | nodes.fe  proof layouts: packed (nodes end to end) and ABI bytes[]       |
   | state.fe  headers, accounts, slots; BlockHash / StateRoot / StorageRoot  |
   | slots.fe  Solidity and Vyper storage layouts, token balance layouts      |
   | hash.fe   Keccak-256 per target (#[cfg])                                 |
   +---------------+-------------------------+----------------------+---------+
                   |                         |                      |
        ingots/contracts (EVM)      ingots/cli (native)       wasm/exports.fe (wasm)
        StateReader                 ferrotype read/balance/    read_storage, read_header,
        Plebiscite = history.fe     propose/vote/verify        lookup, balance_slot
          + ballot.fe (ledger)      json.fe, rpc.fe (curl),    + web/src/ferrotype.js host
          + weight from proofs      chain.fe (headers)
```

- `ingots/conformance` holds the tests: real mainnet proofs, 333 generated vectors, the contracts, and the ballot rules.
- `bench/` measures gas against the audited Solidity verifiers on the same proofs (Foundry).
- `scripts/` fetch fixtures, generate vectors and tests, bundle the wasm module, render this README's numbers, and run the end-to-end flow.

## Results

**Correctness, on three runtimes.** The same 333 generated proof vectors (from the reference implementation `@ethereumjs/trie`: presence, embedded nodes, all three shapes of absence, 141 invalid proofs each with its expected reason) and the mainnet fixtures pass on every target:

| Target | Command | Result |
|---|---|---|
| EVM | `fe test ingots/conformance` | 368 passed |
| Native | `fe test --backend native ingots/conformance` | 350 passed (the 18 contract tests are EVM-only) |
| WebAssembly | `node wasm/check.mjs` | 351 checks passed |

**Gas.** Execution gas for one read (account proof, then storage proof), on the same real mainnet proofs, measured with Foundry ([`bench/`](bench/README.md)). "unsupported" means the verifier reverts on that valid proof: it cannot prove that case.

<!-- gas:begin -->
| Verifier | USDC balance | USDC, flagged holder | WETH, empty slot (absence) | Absent account | EOA, no storage |
|---|---:|---:|---:|---:|---:|
| Optimism Bedrock `SecureMerkleTrie` (audited) | 514,491 | 485,328 | unsupported | unsupported | unsupported |
| Lido `StateProofVerifier` (audited, solc 0.6.12) | 344,979 | 330,229 | 314,531 | 158,196 | 200,937 |
| Lido `StateProofVerifier`, solc 0.8 port | 572,921 | 551,087 | 523,474 | 263,697 | 340,520 |
| **Ferrotype**, `bytes[]` proofs | 177,758 | 167,272 | 165,702 | 86,726 | 97,478 |
| **Ferrotype**, packed proofs | 179,618 | 169,380 | 167,426 | 87,805 | 98,699 |
<!-- gas:end -->

Absence proofs cost <!-- n:vs_lido_absent -->47%<!-- /n --> less than Lido's. Counting calldata, a full read transaction costs <!-- n:fe_tx -->314,410<!-- /n --> gas with packed proofs against <!-- n:lido_tx -->485,611<!-- /n --> for Lido's.

**Soundness.** Of the three verifiers, Ferrotype is the only one that proves absence and rejects a proof whose node list stops early (`bench/results/soundness.json`). The reference `@ethereumjs/trie` `verifyProof` accepts 12 of the 21 structurally malformed vectors and ignores unused nodes; Ferrotype rejects all of them with the expected reason.

**Which abstractions are free.** Measured on the USDC read:

| Change | Gas |
|---|---:|
| Branch nodes decoded in one pass, instead of counting the 17 items and then skipping to the child | −47% |
| `-O 2` instead of the default `-O 1` | −0.5% |
| `#[arithmetic(unchecked)]` on the two hot RLP functions | −1.0% (not used: checked arithmetic stays) |

Bounds-checked span reads, `Option`/`Result` everywhere and typed roots cost little next to the algorithm; the library has no `unsafe` at all, so depending on it needs no `allow_unsafe`.

## Build and test

Requirements: Fe 26.6.0 (`fe --version` prints `fe 26.6.0 (5b3f96a)`); for native builds, x86-64 Linux or AArch64 macOS with a C toolchain and `curl`; Foundry for the benchmark and the local chain; Node.js for the browser module check.

```sh
fe --version                                   # fe 26.6.0
fe test ingots/conformance                     # EVM
fe test --backend native ingots/conformance    # native
scripts/build.sh                               # out/ (contracts), target/bin/ferrotype (CLI)
node wasm/check.mjs                            # the prebuilt web/public/ferrotype.wasm
(cd bench && forge test -vv)                   # gas against Optimism and Lido
anvil & RPC=http://127.0.0.1:8545 scripts/e2e.sh   # governance end to end
```

Or everything in one container: `docker build -t ferrotype . && docker run --rm ferrotype`.

The WebAssembly backend is a Cargo feature that the Fe release binaries do not include. `web/public/ferrotype.wasm` is prebuilt with Fe v26.6.0 (`5b3f96a`) compiled with `--features wasm,cranelift`; its manifest records the module's SHA-256 and the compiler. To rebuild it: `docker build --build-arg WASM=1 -t ferrotype .`, or build that compiler and run `FE_WASM=/path/to/fe scripts/build.sh`. The backend compiles one standalone file, so [`scripts/bundle_wasm.py`](scripts/bundle_wasm.py) places the library's modules inline, unchanged, before the exports.

## Demo

Read a slot of any contract, proven, from any node:

```
$ ferrotype balance --rpc https://ethereum-rpc.publicnode.com \
    --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
    --holder 0x28C6c06298d514Db089934071355E5743bf21d60 --layout flagged --slot 9
block    26445692 0xb0c139281db951cb15bc6c84249f586b247676a27b19bc528509f67364941d72 (header hash checked)
state    0x7bc0190f96d5575bf230781cbeaf1ba351456c97c19a9d3e2cecd3e63d5dac9f
token    0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
holder   0x28c6c06298d514db089934071355e5743bf21d60
slot     0x07081a045c3dbf2e63b62a407ef205e7586e2629d2e2b95ff093308ca0ff3727
balance  52363119552
flagged  yes: the token marks this holder (for USDC, blacklisted)
```

Check a saved proof with no network: `ferrotype verify fixtures/mainnet/usdc.json`.

The governance flow end to end, on a local chain (`scripts/e2e.sh`): deploy a plain ERC-20 and a Plebiscite, open a proposal anchored to a real block hash, move tokens after the snapshot, vote with storage proofs built by the CLI (the tally counts snapshot balances: 700 for, 300 against), see a second vote, a borrowed proof and a second execution refused, and execute the treasury payment.

## Limitations

- Fe 26 is not production-ready, and neither is this code: it is unaudited. Use it on testnets.
- A proposal must be opened within 256 blocks of its snapshot block (configurable up to 8,191 through EIP-2935). Fetching a proof for an older block needs an archive node.
- `Plebiscite` reads balances from a token's own storage, so it needs the token's layout: Solidity and Vyper mappings and USDC-style flag bits are built in. Rebasing tokens (stETH shares), balances behind proxies with custom layouts, delegation and vote by signature are not supported.
- A proposal makes one call. Voters vote from the address that held the tokens; a smart-wallet holder votes through its wallet.
- The native CLI needs x86-64 Linux or AArch64 macOS (Fe's native targets) and `curl`. Its JSON reader does not decode string escapes; JSON-RPC answers do not use them.
- The WebAssembly module needs a compiler built with the `wasm` feature, and the bundling step above.
- Gas varies with trie depth; the numbers above are for the five real proofs in `fixtures/mainnet`.

## Declaration

- **Pre-existing work:** none. The repository was started on November 17, 2026, inside the contest window, and everything in it was written during the contest.
- **Third-party code:** `bench/vendor/` holds unmodified copies of Optimism's Bedrock trie libraries (MIT), Lido's state-proof verifier (MIT), Hamdi Allam's Solidity-RLP (Apache-2.0) and Curve's Solidity 0.8 port of Lido's verifier (MIT and Apache-2.0 by file header), used only to measure them; sources, commits and checksums are in `bench/vendor/README.md`. Test vectors are generated with `@ethereumjs/trie` by `scripts/vectors/`. `web/src/` and `wasm/check.mjs` use no dependencies. The Fe standard library is Fe's own.
- **AI assistance:** Claude (Anthropic) was used as a coding assistant throughout: drafting Fe code, tests, scripts and documentation, and researching the Fe standard library and the Solidity verifiers. Every change was compiled, tested and reviewed by the author, and every number in this README is produced by a script in this repository.

## Team

Yehor Ivashchenko ([@RaYYeR220](https://github.com/RaYYeR220)), solo.

## License

MIT, see [LICENSE](LICENSE).
