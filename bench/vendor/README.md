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

## Curve, patched: `curve-xdao/`

Curve's later copy of Lido's two libraries, with the fix for proofs that end right after a branch node. The bench runs it as a control: apart from that fix, custom errors and style changes, the algorithm is the one in `lido/` and `curve-port/`.

- Upstream: [curvefi/curve-xdao](https://github.com/curvefi/curve-xdao), `contracts/libs/`
- Pinned: commit `14a4d1ba8e7b011e4a2dcf6060e39cfee9786da2` (`master` HEAD on 2026-11-19, a merge from 2026-08-20). The fix is `c82541cc12cdbd1eab41ba08305279be043e1ad1` (Roman Agureev, 2025-04-03, "fix: MPT proof verifier"). It adds a bare `revert()` when the last node of a proof is a branch node whose child at the key's nibble is not empty. `9195fa966575c8926450cf2b043fcd16f49b489d` (2025-08-19) names that revert `NoChild()` and adds `revert Unreachable()` after the loop. The last commit to touch either file is `cf033982e49f28f70350a8213ffbf97ad02b8072` (2025-09-15).
- License: MIT. Both files carry `SPDX-License-Identifier: MIT`. `curve-xdao/LICENSE.txt` is the repository's root `LICENSE.txt` at that commit, an MIT license (Copyright (c) 2023 Curve Finance). This repository has no all-rights-reserved notice, unlike `curve-merkle-oracle`. `MerklePatriciaProofVerifier.sol` says it is copied from Lido's `1033b3e`, which is adapted from lorenzb/proveth `c74b20e`.
- Pragma: `0.8.18` exactly. Compiled with solc 0.8.18. That solc predates shanghai, so forge targets paris for it.

| File | sha256 |
|---|---|
| `contracts/libs/MerklePatriciaProofVerifier.sol` | `d3e421fb7d9bd1eac23aad974c37bbdeaa12de2e28e80393446520b76562b8ea` |
| `contracts/libs/StateProofVerifier.sol` | `a78e2d1fe239f4f06d2db50b85897278e789daf3f2b7f1c58d06bd6dca43bc4a` |
| `LICENSE.txt` | `93b1500b944e2fb2542fb5d222dd0607a0c7c4dfb67216e0e753a354e14e97d4` |

Both files import `hamdiallam/Solidity-RLP@2.0.7/contracts/RLPReader.sol`, which the repository declares in `brownie-config.yaml` and does not include. `curve-xdao/solidity-rlp/` holds that dependency.

- Upstream: [hamdiallam/Solidity-RLP](https://github.com/hamdiallam/Solidity-RLP), `contracts/RLPReader.sol`
- Pinned: tag `v2.0.7` = commit `ca4929893192fc1568ad693b9c7e43d3b59ef27c` (2023-02-13, "support solidity 0.8.18")
- License: Apache-2.0. `solidity-rlp/LICENSE` is the repository's license at that commit, byte-identical to `../solidity-rlp/LICENSE`. The file keeps its SPDX header and author notice.
- Pragma: `>=0.5.10 <=0.8.18`.

| File | sha256 |
|---|---|
| `solidity-rlp/contracts/RLPReader.sol` | `b015fdcd8dd89ef0365ced9f733bde9edc20b6ec57259855aee4824d69a8ee07` |
| `solidity-rlp/LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

## Checking the copies

```sh
cd bench
sha256sum vendor/*/src/libraries/*.sol vendor/*/src/libraries/*/*.sol vendor/*/contracts/*.sol \n  vendor/curve-xdao/contracts/libs/*.sol vendor/curve-xdao/solidity-rlp/contracts/*.sol
```
