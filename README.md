# Ferrotype

[![CI](https://github.com/RaYYeR220/ferrotype/actions/workflows/ci.yml/badge.svg)](https://github.com/RaYYeR220/ferrotype/actions/workflows/ci.yml)

**Live:** [ferrotype.vercel.app](https://ferrotype.vercel.app) · **Video:** [the demo in 2:40](https://youtu.be/1mOroCLm2z8) · **Try it:** [ferrotype.vercel.app/try](https://ferrotype.vercel.app/try) checks one read three ways, in your browser as WebAssembly, in the contract on Sepolia and with the native CLI, and lets you damage the proof · contracts on Sepolia: [below](#live-on-sepolia).

**Pitch:** Ferrotype lets a contract read any other contract's storage at a past block, proven from nothing but a block hash it trusts, for <!-- n:fe_gas -->178,338<!-- /n --> gas — <!-- n:vs_lido -->48%<!-- /n --> less than Lido's audited verifier and <!-- n:vs_op -->65%<!-- /n --> less than Optimism's — with one Fe codebase that runs on-chain, in a native CLI and in the browser.

A DAO wants USDC holders to vote on its treasury. USDC has no checkpoints and never will: no one upgrades a $75B token for one DAO. Today the answer is an off-chain snapshot server that everyone has to trust. With Ferrotype the DAO reads each voter's balance straight out of USDC's storage at the proposal's block, proven against the block hash the chain itself remembers. The token cooperates without knowing it.

## The problem

Every contract's storage is committed to by the block header, through two Merkle-Patricia tries: the state trie holds the account, the account's storage trie holds the slot. So any contract could, in principle, read any other contract's state at any recent block, from a proof. In practice:

- The machinery is missing in Fe. The Fe team's own words: *"Merkle-Patricia proofs of another contract's storage: the precompiles are wrapped in std, but most of the machinery around them is still waiting to be written."*
- The Solidity machinery is expensive or incomplete. Optimism's audited `MerkleTrie` cannot prove that a slot is empty, so a zero balance or a missing account cannot be read at all. Lido's audited `StateProofVerifier` proves absence, but accepts a proof whose node list stops early after a branch node, reading the slot as zero: the class of bug [Roman Agureev of Curve found](https://hackmd.io/@agureevroman/Sk9gl-zVll) in March 2025, whose disclosure ChainSecurity coordinated ([write-up](https://www.chainsecurity.com/blog/when-empty-means-valid-exploiting-mpt-proof-verification-for-an-alternative-truth)). Both copy every node into fresh memory before decoding it.
- The off-chain half is written twice. The tool that fetches proofs from a node, the keeper that submits them and the UI that previews them each reimplement the verifier in another language, and the copies drift apart.

## Approach

One library, written once in Fe, compiled three ways:

| Runtime | What runs | Built with |
|---|---|---|
| EVM | `StateReader` (read any slot, given a state root) and `Plebiscite` (a treasury governed by any ERC-20's holders) | `fe build -O 2` |
| Native | `ferrotype`, a CLI that talks to an Ethereum node, proves every value before printing it, and prints the calldata the contracts accept | `fe build --backend native` |
| WebAssembly | the verifier in the browser: a page checks a proof before a wallet ever sees it | `fe build --backend wasm` |

The verifier ([`trie.fe`](ingots/ferrotype/src/trie.fe), [`rlp.fe`](ingots/ferrotype/src/rlp.fe)) walks a proof in place. All nodes live in one buffer; every node and every embedded child is a range of it. Nothing is copied, no item list is allocated, and a branch node is decoded in a single pass with fast paths for the two headers almost every child has (a 32-byte hash, or empty). It proves presence and absence (an empty branch slot, or a leaf or extension whose path diverges), follows embedded nodes, and rejects everything else with a reason: `Malformed`, `HashMismatch`, `MissingNode`, `ExtraNodes`, `BadReference`. Only canonical RLP is accepted, and an account's nonce and balance and a slot's value must be canonical integers, with no leading zero byte.

On top of it, [`state.fe`](ingots/ferrotype/src/state.fe) decodes block headers of every fork (one decoder: every fork keeps the first fifteen fields) and proves accounts and slots, and [`slots.fe`](ingots/ferrotype/src/slots.fe) knows where Solidity and Vyper put mappings and how tokens pack balances, including USDC's blacklist bit.

[`Plebiscite`](ingots/contracts/src/plebiscite.fe) uses all of it. Opening a proposal anchors it to a fresh block: the header must be at most `max_snapshot_age` blocks old (16 in the deployments) and hash to what `BLOCKHASH` returns for it, its state root proves the token's account, and the account's storage root is kept. The proposer proves their own balance at that block, which must reach the proposal threshold (1% of the supply for the demo DAO; 0 lets any holder propose). From then on a vote needs one short storage proof, of the voter's own balance slot. Balances are counted at the snapshot block, so tokens moved after it vote nowhere twice; a holder the token flags (USDC's blacklist) can neither vote nor propose; quorum is a share of the total supply proven at the same block, a supply of zero is refused, and so is a vote heavier than the supply. A proposal that passed is executed by anyone after a timelock and before a grace period ends, and its call is made with exactly the gas the proposal named: `execute` refuses to start it with less.

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

The capabilities of every handler are in its signature, checked by the compiler: a handler that does not list an effect or a storage field cannot reach it. In `Plebiscite` only `Execute` lists `call`, and it hands it to one free function, `pay`, the treasury's only outgoing call, whose own `uses` clause takes it mutably. `Propose` checks its header with `BLOCKHASH`, a read of the block context, and lists no `call` at all:

```fe
Propose { header, token_proof, supply_proof, proposer_proof, target, value, gas, data } -> u256
    uses (ctx, token, layout_kind, balance_slot, supply_slot, voting_period, max_snapshot_age,
          proposal_threshold_bps, mut ledger, mut log)
Vote { id, support, balance_proof } -> u256 uses (ctx, layout_kind, balance_slot, mut ledger, mut log)
Execute { id, data } -> bool uses (ctx, mut call, quorum_bps, timelock, grace, mut ledger, mut log)

pub fn pay(_ target: Address, _ value: Wei, _ data: Bytes, gas: u256) uses (call: mut Call)
```

Calling `pay` from `Vote` is a compile error (`missing effect Call required by pay`). Checking this claim turned up a gap: Fe 26.6 does not check the `mut` marker of a contract-level effect inside a `recv` arm, so an arm that lists `call` without `mut` can still call it mutably. Ferrotype's arms therefore never call `call` themselves; the finding is reported upstream with a minimal reproduction ([argotorg/fe#2047](https://github.com/argotorg/fe/issues/2047)).

And the trie roots are types, so a proof cannot be checked against the wrong trie:

```fe
pub fn storage<N: Nodes>(_ buf: MemSpan, nodes: mut N, root: StorageRoot, slot: u256) -> Result<ProofError, u256>
```

`state::storage(.., root: header.state_root, ..)` does not compile: a `StateRoot` is not a `StorageRoot`, and the only way to get one is to prove an account.

More Fe that carries weight here:
- The CLI encodes calldata from the contracts' own `msg` types (`<M as MsgVariant<Sol>>::SELECTOR` and the std ABI encoder), so its output cannot drift from what the contracts decode.
- Its network access is a capability too: `rpc::call` `uses (proc: mut Spawn)` and runs `curl`; nothing that does not declare `Spawn` can reach the network.
- `Wei`, `Timestamp` and `Duration` keep amounts, deadlines and the timelock apart in the ballot, and the execution window is measured from the deadline (`now - deadline`), so no sum of durations can overflow; the compiler checks every `sol(...)` selector against its fields' ABI types.

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
        Plebiscite (BLOCKHASH)      propose/vote/verify        lookup, balance_slot
          + ballot.fe (ledger)      json.fe, rpc.fe (curl),    + web/src/ferrotype.js host
          + weight from proofs      chain.fe (headers)
```

- `ingots/conformance` holds the tests: real mainnet proofs, <!-- n:vectors -->343<!-- /n --> generated vectors, hostile inputs found in review, the contracts, and the ballot rules.
- `bench/` measures gas against the audited Solidity verifiers on the same proofs (Foundry).
- `scripts/` fetch fixtures, generate vectors and tests, bundle the wasm module, render this README's numbers, and run the end-to-end flow.

## Results

**Correctness, on three runtimes.** The same <!-- n:vectors -->343<!-- /n --> generated proof vectors (from the reference implementation `@ethereumjs/trie`: presence, embedded nodes, all three shapes of absence, <!-- n:invalid_vectors -->148<!-- /n --> invalid proofs each with its expected reason, among them RLP lengths written in more bytes than a 32-bit integer holds and stored integers with a leading zero) and the mainnet fixtures pass on every target:

| Target | Command | Result |
|---|---|---|
| EVM | `fe test ingots/conformance` | <!-- n:evm_tests -->402<!-- /n --> passed |
| Native | `fe test --backend native ingots/conformance` | <!-- n:native_tests -->373<!-- /n --> passed (the contract tests are EVM-only; the million-round fuzz test is native-only) |
| WebAssembly | `node wasm/check.mjs` | <!-- n:wasm_checks -->377<!-- /n --> checks passed (the vectors, the mainnet reads, and the traced reads) |

**Damaged proofs.** [`fuzz.fe`](ingots/conformance/src/fuzz.fe) damages the mainnet proofs at random (bit flips, overwritten bytes, cut tails, removed ranges, appended bytes, one 32-byte window copied over another) and verifies them. Of <!-- n:fuzz_rounds -->1,000,000<!-- /n --> damaged proofs, <!-- n:fuzz_true -->679<!-- /n --> still prove the true value (in <!-- n:fuzz_unchanged -->679<!-- /n --> of those rounds the damage left the bytes as they were, a byte overwritten with itself or a window copied over identical bytes; the fuzzer compares them), <!-- n:fuzz_rejected -->999,321<!-- /n --> are rejected, and <!-- n:fuzz_wrong -->0<!-- /n --> prove a wrong value; the verifier never panics. The EVM and native builds reach the same verdict on every one of the first 300 rounds: both fold their verdicts into the same digest (`every_target_reaches_the_same_300_verdicts`). Run it with `fe build --backend native ingots/fuzz --out-dir target/fuzz && target/fuzz/fuzz 1000000 1`.

**Gas.** Execution gas for one read (account proof, then storage proof), on the same real mainnet proofs, measured with Foundry ([`bench/`](bench/README.md)). "unsupported" means the verifier reverts on that valid proof: it cannot prove that case.

<!-- gas:begin -->
| Verifier | USDC balance | USDC, flagged holder | WETH, empty slot (absence) | Absent account | EOA, no storage |
|---|---:|---:|---:|---:|---:|
| Optimism Bedrock `SecureMerkleTrie` (audited) | 514,491 | 485,328 | unsupported | unsupported | unsupported |
| Lido `StateProofVerifier` (audited, solc 0.6.12) | 344,979 | 330,229 | 314,531 | 158,196 | 200,937 |
| Lido `StateProofVerifier`, solc 0.8 port | 572,921 | 551,087 | 523,474 | 263,697 | 340,520 |
| Curve `curve-xdao` (patched, 2025, solc 0.8.18) | 597,272 | 573,940 | 546,255 | 275,932 | 353,841 |
| **Ferrotype**, `bytes[]` proofs | 178,338 | 167,836 | 166,243 | 87,125 | 97,814 |
| **Ferrotype**, packed proofs | 180,173 | 169,919 | 167,945 | 88,183 | 99,014 |
<!-- gas:end -->

Absence proofs cost <!-- n:vs_lido_absent -->47%<!-- /n --> less than Lido's. Among the verifiers that reject a proof that stops early, Ferrotype costs <!-- n:vs_curve -->70%<!-- /n --> less than Curve's patched one and <!-- n:vs_op -->65%<!-- /n --> less than Optimism's, which cannot prove absence at all. Counting calldata, a full read transaction costs <!-- n:fe_tx -->314,965<!-- /n --> gas with packed proofs against <!-- n:lido_tx -->485,611<!-- /n --> for Lido's.

**Soundness.** Lido's verifier accepts a proof whose node list stops early after a branch node and reads the slot as zero. Ferrotype and Curve's patched copy reject it, and Ferrotype costs <!-- n:vs_curve -->70%<!-- /n --> less; Optimism's rejects it too, but cannot prove absence at all (`bench/results/soundness.json`). The benchmark reproduces this publicly disclosed bug class on real proofs. The reference `@ethereumjs/trie` `verifyProof` accepts <!-- n:ejs_malformed_accepted -->17<!-- /n --> of the <!-- n:ejs_malformed -->28<!-- /n --> malformed vectors (<!-- n:ejs_values_accepted -->5<!-- /n --> of them because it does not decode stored values) and ignores unused nodes; Ferrotype rejects all of them with the expected reason.

**Which abstractions are free.** Measured on the USDC read:

| Change | Gas |
|---|---:|
| Branch nodes decoded in one pass, instead of counting the 17 items and then skipping to the child | −47% |
| `-O 2` instead of the default `-O 1` | −0.5% |
| `#[arithmetic(unchecked)]` on the two hot RLP functions | −1.0% (not used: checked arithmetic stays) |
| A generic `Observer` on the lookup (the browser shows the verifier's own steps), called on a no-op observer | +1.5% |
| The same observer behind an associated `const WATCHING: bool` that is `false` for the no-op | +0.14% (shipped) |
| `#[inline(always)]` on the `lookup` wrapper as well | +0.2% more (not used) |

A trait method called on every node is not free even when its body is empty; gating it on an associated constant lets the compiler fold the call away. Bounds-checked span reads, `Option`/`Result` everywhere and typed roots cost little next to the algorithm; the library has no `unsafe` at all, so depending on it needs no `allow_unsafe`.

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

### Live on Sepolia

A 2:40 walkthrough of everything below: [https://youtu.be/1mOroCLm2z8](https://youtu.be/1mOroCLm2z8).

The contracts are deployed on Sepolia and the governance flow has run there end to end. Every address and transaction below is rendered from [`deployments/sepolia.json`](deployments/sepolia.json), written by `scripts/deploy.sh`.

<!-- deploy:begin -->
| Contract | Address | Role |
|---|---|---|
| `StateReader` | [`0x32d2772c57b9590836d5eec2c6197dfb3f31822c`](https://sepolia.etherscan.io/address/0x32d2772c57b9590836d5eec2c6197dfb3f31822c) | verifies a storage proof against a state root (`storageAt`, `storageAtPacked`) |
| `PlebisciteDemo` | [`0x5bf1b14291b78b9365d5eb5427fdd982bab3c70b`](https://sepolia.etherscan.io/address/0x5bf1b14291b78b9365d5eb5427fdd982bab3c70b) | governance and treasury for `DemoToken`, 30-minute votes |
| `DemoToken` | [`0xa7dbb2b154ed725667e51a0fbe79aa7ef659ffed`](https://sepolia.etherscan.io/address/0xa7dbb2b154ed725667e51a0fbe79aa7ef659ffed) | a minimal ERC-20 written in Fe (balances at slot 0, supply at slot 1) |
| `PlebisciteUSDC` | [`0xf176337560f3e6f3dd375722a0c151264f683d50`](https://sepolia.etherscan.io/address/0xf176337560f3e6f3dd375722a0c151264f683d50) | governance for Sepolia USDC (balances with a flag bit at slot 9, supply at slot 11) |

The governance run on Sepolia, transaction by transaction:

1. proposal 1 opens, anchored to a block hash the chain remembers: [`0xd15eb4d0…`](https://sepolia.etherscan.io/tx/0xd15eb4d0384ae115b4a1ceef1cd553e3c7d7a86b08d7045d58a784ac2e44b0a3)
1. Alice sends 500 tokens to Carol after the snapshot: [`0x1c22a8a9…`](https://sepolia.etherscan.io/tx/0x1c22a8a90981e838cb171b74c041ebc6a66d17a0e98d08980a2bf538d4697531)
1. Alice votes for with 600 (her snapshot balance, not today's 100): [`0x749174c1…`](https://sepolia.etherscan.io/tx/0x749174c1b16b5db6134e9cde39da45a1953039fed90616d4a387adcd96d8b07b)
1. Bob votes against with 300: [`0x246eecca…`](https://sepolia.etherscan.io/tx/0x246eeccadf17b758ff2cddd8bcb84b34e30c680dd41922de8c6ccbec305d0b01)
1. Carol votes for with 100 (not the 600 she holds now): [`0x64e4c092…`](https://sepolia.etherscan.io/tx/0x64e4c0925588df940231f36310e93e2792a403d629d28ccefbddd67e328cc856)
1. after the vote, the treasury pays 0.001 ETH to `0x…c0de`: [`0x73217c18…`](https://sepolia.etherscan.io/tx/0x73217c18f15f373ddc49a0fe164dd73ed3053ffe2a1147f00cabd405bc80f779)
1. a USDC proposal opens, so anyone can ask for a holder's voting power: [`0x166bfd2b…`](https://sepolia.etherscan.io/tx/0x166bfd2b6f789df8153ec2a56e202145f802037286a002ae20a4355cc0f49ed1)
<!-- deploy:end -->

The [demo page](https://ferrotype.vercel.app/try) runs one read through the browser module and the deployed `StateReader` side by side, next to the native CLI's recorded output on the same file, and asks both Plebiscites for voting power. Anyone can ask the deployed contracts, with no funds: `StateReader` checks any proof against any state root (mainnet proofs included), and each Plebiscite answers `votingPower(id, holder, proof)` for a balance proof at its snapshot block. [`deployments/sepolia-snapshots.json`](deployments/sepolia-snapshots.json) keeps such proofs for the three demo voters and eight USDC holders, fetched when the proposals opened (`scripts/capture_snapshots.py`). `python3 scripts/check_live.py` asks the contracts all of this with `eth_call` and prints a pass or fail per check.

### From a terminal

Read a slot of any contract, proven, from any node:

```
$ ferrotype balance --rpc https://ethereum-rpc.publicnode.com \
    --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
    --holder 0x28C6c06298d514Db089934071355E5743bf21d60 --layout flagged --slot 9
trust    the block hash came from the node; pass --block-hash to check it against one you trust
block    26445692 0xb0c139281db951cb15bc6c84249f586b247676a27b19bc528509f67364941d72 (header hash checked)
state    0x7bc0190f96d5575bf230781cbeaf1ba351456c97c19a9d3e2cecd3e63d5dac9f
token    0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
holder   0x28c6c06298d514db089934071355e5743bf21d60
slot     0x07081a045c3dbf2e63b62a407ef205e7586e2629d2e2b95ff093308ca0ff3727
balance  52363119552
flagged  yes: the token marks this holder (for USDC, blacklisted)
```

Every node and every value is checked, but the block hash everything is proven against still comes from the node. The proof is trustless only against a block hash you trust: pass one with `--block-hash` (from your own node, a light client, or two providers that agree) and the header must hash to it, or the CLI refuses. The contracts need no such step: they take the hash from `BLOCKHASH`.

Check a saved proof with no network: `ferrotype verify fixtures/mainnet/usdc.json`.

The governance flow end to end, on a local chain (`scripts/e2e.sh`): deploy a minimal ERC-20 and a Plebiscite, see a proposer below the threshold and a header older than the maximum snapshot age refused, open a proposal anchored to a fresh block hash, move tokens after the snapshot, vote with storage proofs built by the CLI (the tally counts snapshot balances: 700 for, 300 against), see a second vote, a borrowed proof, an execution during the timelock and a second execution refused, execute the treasury payment, and spend an allowance with `transferFrom`.

## Limitations

- Fe 26 is not production-ready, and neither is this code: it is unaudited. Use it on testnets.
- A proposal must be opened within `max_snapshot_age` blocks of its snapshot block: 16 in the deployments (about three minutes), at most 64. A proposer who could pick any block in a long window could pick one at which borrowed or briefly held tokens weigh the most; a fresh snapshot leaves little to pick from, and it is checked with `BLOCKHASH` alone. Fetching a proof for an older block needs an archive node, and free public nodes keep very little: in November 2026 publicnode answers `eth_getProof` on Sepolia only for the newest block and Tenderly's gateway for about the last hundred. A voter therefore votes soon after a proposal opens, or uses an archive node.
- The token's flag (USDC's blacklist) is read at the snapshot block only: a holder flagged after it still votes with its snapshot balance, and one unflagged after it still cannot.
- `Plebiscite` reads balances from a token's own storage, so it needs the token's layout: Solidity and Vyper mappings and USDC-style flag bits are built in (tested on mainnet USDC and on CRV, a Vyper token). Rebasing tokens (stETH shares), balances behind proxies with custom layouts, delegation and vote by signature are not supported.
- A proposal makes one call, with the gas it names. Voters vote from the address that held the tokens; a smart-wallet holder votes through its wallet.
- The native CLI needs x86-64 Linux or AArch64 macOS (Fe's native targets) and `curl`. Its JSON reader does not decode string escapes; JSON-RPC answers do not use them.
- The WebAssembly module needs a compiler built with the `wasm` feature, and the bundling step above.
- Gas varies with trie depth; the numbers above are for the five reads in the benchmark, taken from four of the proofs in `fixtures/mainnet`.

## Declaration

- **Pre-existing work:** none. The repository was started on November 17, 2026, inside the contest window, and everything in it was written during the contest.
- **Third-party code:** `bench/vendor/` holds unmodified copies of Optimism's Bedrock trie libraries (MIT), Lido's state-proof verifier (MIT), Hamdi Allam's Solidity-RLP (Apache-2.0), Curve's Solidity 0.8 port of Lido's verifier (MIT and Apache-2.0 by file header) and Curve's patched `curve-xdao` verifier (MIT), used only to measure them; sources, commits and checksums are in `bench/vendor/README.md`. Test vectors are generated with `@ethereumjs/trie` by `scripts/vectors/`. `web/src/` and `wasm/check.mjs` use no dependencies; the site's fonts are Gambetta and Switzer (Indian Type Foundry, ITF Free Font License) and JetBrains Mono (OFL), listed in `web/fonts/LICENSE.txt`. The Fe standard library is Fe's own.
- **AI assistance:** Claude (Anthropic) was used as a coding assistant throughout: drafting Fe code, tests, scripts and documentation, and researching the Fe standard library and the Solidity verifiers. Every change was compiled, tested and reviewed by the author, and every number in this README is produced by a script in this repository.

## Team

Yehor Ivashchenko ([@RaYYeR220](https://github.com/RaYYeR220)), solo.

## License

MIT, see [LICENSE](LICENSE).
