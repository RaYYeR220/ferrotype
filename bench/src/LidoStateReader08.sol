// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { RLPReader } from "@lido-0.8/RLPReader.sol";
import { StateProofVerifier } from "@lido-0.8/StateProofVerifier.sol";

/// @title LidoStateReader08
/// @notice The same wrapper on Curve's 0.8 port of Lido's StateProofVerifier (pragma bumps and one
///         address-cast fix, algorithm unchanged), compiled with the bench's 0.8 solc.
contract LidoStateReader08 {
    using RLPReader for bytes;

    /// @dev keccak256(rlp("")): the storage root of an account with no storage, absent ones included.
    bytes32 internal constant EMPTY_TRIE_ROOT = 0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421;

    function storageAt(
        bytes32 stateRoot,
        address account,
        bytes32 slot,
        bytes[] memory accountProof,
        bytes[] memory storageProof
    )
        external
        pure
        returns (uint256)
    {
        StateProofVerifier.Account memory acct = StateProofVerifier.extractAccountFromProof(
            keccak256(abi.encodePacked(account)), stateRoot, _toItems(accountProof)
        );
        // A proven-absent account has an empty storage trie.
        bytes32 storageRoot = acct.exists ? acct.storageRoot : EMPTY_TRIE_ROOT;

        StateProofVerifier.SlotValue memory slotValue = StateProofVerifier.extractSlotValueFromProof(
            keccak256(abi.encodePacked(slot)), storageRoot, _toItems(storageProof)
        );
        return slotValue.value; // 0 when the slot is proven absent
    }

    /// @dev The library takes the proof as RLP items. Each node is one complete RLP item.
    function _toItems(bytes[] memory nodes) private pure returns (RLPReader.RLPItem[] memory items) {
        items = new RLPReader.RLPItem[](nodes.length);
        for (uint256 i = 0; i < nodes.length; i++) {
            items[i] = nodes[i].toRlpItem();
        }
    }
}
