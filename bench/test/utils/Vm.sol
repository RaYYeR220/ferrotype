// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @notice The forge cheatcodes this bench uses, with signatures copied from forge-std's Vm.sol.
///         Declaring only these keeps the bench free of dependencies: `forge test` is enough.
interface Vm {
    // Files
    function readFile(string calldata path) external view returns (string memory data);
    function isFile(string calldata path) external view returns (bool result);

    // JSON
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytesArray(string calldata json, string calldata key) external pure returns (bytes[] memory);
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;

    // Strings
    function parseBytes(string calldata stringifiedValue) external pure returns (bytes memory parsedValue);
    function trim(string calldata input) external pure returns (string memory output);
    function toString(uint256 value) external pure returns (string memory stringifiedValue);
    function toString(bytes32 value) external pure returns (string memory stringifiedValue);
    function toString(bytes calldata value) external pure returns (string memory stringifiedValue);
    function toString(address value) external pure returns (string memory stringifiedValue);

    // Deployment
    function deployCode(string calldata artifactPath) external returns (address deployedAddress);
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function label(address account, string calldata newLabel) external;

    // Assertions
    function assertEq(uint256 left, uint256 right, string calldata err) external pure;
    function assertTrue(bool condition, string calldata err) external pure;
}

/// @notice forge's console, string-only.
library console {
    address internal constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    function log(string memory message) internal view {
        bytes memory payload = abi.encodeWithSignature("log(string)", message);
        address target = CONSOLE;
        assembly ("memory-safe") {
            pop(staticcall(gas(), target, add(payload, 0x20), mload(payload), 0, 0))
        }
    }
}
