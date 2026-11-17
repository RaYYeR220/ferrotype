// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { SecureMerkleTrie } from "@optimism/libraries/trie/SecureMerkleTrie.sol";
import { RLPReader } from "@optimism/libraries/rlp/RLPReader.sol";

/// @title OptimismStateReader
/// @notice storageAt() on Optimism Bedrock's SecureMerkleTrie and RLPReader.
/// @dev Bedrock's MerkleTrie proves inclusion only. It reverts on every exclusion proof (an
///      absent account, an absent or zero slot) by design, so this wrapper reverts there too.
///      Turning that revert into 0 would also turn every malformed proof into 0.
contract OptimismStateReader {
    function storageAt(
        bytes32 stateRoot,
        address account,
        bytes32 slot,
        bytes[] memory accountProof,
        bytes[] memory storageProof
    )
        external
        pure
        returns (uint256 value)
    {
        // State trie leaf: rlp([nonce, balance, storageRoot, codeHash]).
        RLPReader.RLPItem[] memory fields =
            RLPReader.readList(SecureMerkleTrie.get(abi.encodePacked(account), accountProof, stateRoot));
        require(fields.length == 4, "OptimismStateReader: bad account");
        bytes memory storageRoot = RLPReader.readBytes(fields[2]);
        require(storageRoot.length == 32, "OptimismStateReader: bad storage root");

        // Storage trie leaf: rlp(value, big-endian, leading zeros stripped).
        // forge-lint: disable-next-line(unsafe-typecast) length checked above
        bytes32 root = bytes32(storageRoot);
        bytes memory raw = RLPReader.readBytes(SecureMerkleTrie.get(abi.encodePacked(slot), storageProof, root));
        require(raw.length <= 32, "OptimismStateReader: bad slot value");
        // forge-lint: disable-next-line(unsafe-typecast) at most 32 bytes, left-aligned, then shifted down
        value = uint256(bytes32(raw)) >> (8 * (32 - raw.length));
    }
}
