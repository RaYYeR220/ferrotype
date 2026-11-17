# Vendored verifiers

Every file here is a byte-for-byte copy of its upstream at the pinned commit. Nothing is edited. Import paths resolve through the remappings in `../foundry.toml`, so no shims were needed: the one extra import Bedrock's `RLPReader.sol` makes (`RLPErrors.sol`) exists upstream and is vendored next to it.

## Optimism Bedrock: `optimism/`

- Upstream: [ethereum-optimism/optimism](https://github.com/ethereum-optimism/optimism), `packages/contracts-bedrock/src/libraries/`
- Pinned: tag `op-contracts/v9.0.0` = commit `ba6fcadbc57eb99918c5b0f14f57c72527f531e3`
- License: MIT. Every file carries `SPDX-License-Identifier: MIT`. `optimism/LICENSE` is the repository's root `LICENSE` at that commit.
- Pragmas: `^0.8.0`, with `RLPReader.sol` at `^0.8.8`. Compiled with solc 0.8.37.

| File | sha256 |
|---|---|
| `src/libraries/trie/SecureMerkleTrie.sol` | `755f79cb43e84d30dec6f1f535809bd4d18594c5d9bedf7407fdc6d374489980` |
| `src/libraries/trie/MerkleTrie.sol` | `9ce13ec201485c87989df0ec89407dde9da8d95d54baf3c4d68fbfeb9d421b0a` |
| `src/libraries/rlp/RLPReader.sol` | `12384103fca5620247d8ca17187a65a61bdf5839b85908132de54d03969dd79b` |
| `src/libraries/rlp/RLPErrors.sol` | `c775036bad8a0e00beeeae9fd20c733dcfdc2ddc57464d70299cb5c148aeec60` |
| `src/libraries/Bytes.sol` | `235a1dcaf00fb7eeb2033033fdca135790c7415054aeb8303e5e070baca6e879` |

## Lido, as audited: `lido/`

- Upstream: `lidofinance/curve-merkle-oracle`, `contracts/`. That repository no longer resolves on GitHub (404 on 2026-11-17). Its full history survives in the fork [curvefi/curve-merkle-oracle](https://github.com/curvefi/curve-merkle-oracle), and the files here come from that history.
- Pinned: commit `1033b3e84142317ffd8f366b52e489d5eb49c73f` (Sam Kozin, 2021-05-14). Lido's README names this commit as audited by MixBytes (May 2021). Both files are unchanged up to `fffd375659358af54a6e8bbf8c3aa44188894c81`, the last Lido-authored commit.
- License: MIT, from each file's `SPDX-License-Identifier: MIT` header. The repository had no top-level `LICENSE` at this commit. `MerklePatriciaProofVerifier.sol` says it is adapted from [lorenzb/proveth](https://github.com/lorenzb/proveth) `c74b20e`.
- Pragma: `0.6.12` exactly. Compiled with solc 0.6.12, optimizer on, 200 runs, matching Lido's own `brownie-config.yaml`.

| File | sha256 |
|---|---|
| `contracts/StateProofVerifier.sol` | `08716ea65a433eec49fbe162f802a10e0ca36053e6507cff1ab816a579e195e0` |
| `contracts/MerklePatriciaProofVerifier.sol` | `4e4f6d7ee9ed418ad55893bf6f871f1c0747d07ba40bccfef87f1b521149621a` |

## Solidity-RLP, as Lido used it: `solidity-rlp/`

- Upstream: [hamdiallam/Solidity-RLP](https://github.com/hamdiallam/Solidity-RLP), `contracts/RLPReader.sol`
- Pinned: tag `v2.0.5` = commit `0e05c26b627deb3066a6534d0e724b92cf9b7f9e`. This is the version Lido's `brownie-config.yaml` declares (`hamdiallam/Solidity-RLP@2.0.5`) and the path its imports use.
- License: Apache-2.0. `solidity-rlp/LICENSE` is the repository's license at that commit. The file keeps its SPDX header and author notice.

| File | sha256 |
|---|---|
| `contracts/RLPReader.sol` | `203cbe1d86a5e62e17219c5b5291859a1ac343cfa7724697312033e9ff70d725` |

## Lido, 0.8 port: `curve-port/`

The same three files ported to Solidity 0.8 by Curve in 2022. The changes are pragma bumps, relative imports, one `address(uint160(...))` cast in `RLPReader.toAddress`, and trailing-whitespace cleanup. The verification algorithm is unchanged. This build shows what Lido's code costs under 0.8's checked arithmetic.

- Upstream: [curvefi/curve-merkle-oracle](https://github.com/curvefi/curve-merkle-oracle), `contracts/`
- Pinned: commit `b395fb24ac260d9801efc35f6aee5b07613b9257` (HEAD, 2022-03-15)
- License: per-file SPDX headers. `StateProofVerifier.sol` and `MerklePatriciaProofVerifier.sol` are MIT, and `RLPReader.sol` is Apache-2.0 (see `../solidity-rlp/LICENSE`). The repository's top-level `LICENSE` is a Curve all-rights-reserved notice that applies "except as otherwise provided in the header of a specific source code file", so the SPDX headers govern these three files. That notice is not copied here.
- Pragma: `>=0.8.12`. Compiled with solc 0.8.37.

| File | sha256 |
|---|---|
| `contracts/StateProofVerifier.sol` | `30f69e024c058fe7e898c21076d25105f5b93896faaf05b442313e63ab4b1304` |
| `contracts/MerklePatriciaProofVerifier.sol` | `062820347d43b2dba054e984230e8fcd8719986f1d17869f0381cfc1d236d518` |
| `contracts/RLPReader.sol` | `6b193c8ad461e42fc36602f05dae786ec1a0ea348bdc7167ee0aff21b4914d9b` |

## Checking the copies

```sh
cd bench
sha256sum vendor/*/src/libraries/*.sol vendor/*/src/libraries/*/*.sol vendor/*/contracts/*.sol
```
