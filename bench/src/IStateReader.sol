// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice The one call every verifier in the bench answers: prove `account` against
///         `stateRoot`, take its storage root, prove `slot` against it, return the slot's value.
///         Returns 0 for a slot proven absent. Reverts on an invalid proof.
interface IStateReader {
    function storageAt(
        bytes32 stateRoot,
        address account,
        bytes32 slot,
        bytes[] calldata accountProof,
        bytes[] calldata storageProof
    ) external view returns (uint256);
}

/// @notice Ferrotype's packed entry point: each proof is its nodes concatenated end to end.
///         Every node is a complete RLP item, so no offsets or lengths travel in calldata.
interface IStateReaderPacked {
    function storageAtPacked(
        bytes32 stateRoot,
        address account,
        bytes32 slot,
        bytes calldata accountProof,
        bytes calldata storageProof
    ) external view returns (uint256);
}
