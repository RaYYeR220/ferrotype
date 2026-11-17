// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Vm, console } from "./utils/Vm.sol";
import { IStateReader, IStateReaderPacked } from "../src/IStateReader.sol";

/// @title StorageProofBench
/// @notice Reads one storage slot of a mainnet contract (account proof against the block's state
///         root, then storage proof against the account's storage root) through every verifier,
///         on the same real eth_getProof fixtures. Asserts every value, then records gas.
contract StorageProofBench {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant FIXTURES = "../fixtures/mainnet/";
    string internal constant FE_BIN = "../out/StateReader.bin";
    string internal constant GAS_JSON = "results/gas.json";
    string internal constant SOUNDNESS_JSON = "results/soundness.json";

    /// @dev Codeless address. A STATICCALL to it costs exactly the call overhead the measured
    ///      calls pay, so subtracting it leaves the gas spent inside the verifier.
    address internal constant NO_CODE = address(0xC0FFEE);

    /// @dev EIP-2028 calldata pricing and the EIP-7623 floor, both per calldata token
    ///      (zero byte = 1 token, nonzero byte = 4 tokens).
    uint256 internal constant GAS_PER_TOKEN = 4;
    uint256 internal constant FLOOR_GAS_PER_TOKEN = 10;
    uint256 internal constant TX_BASE_GAS = 21_000;

    struct Impl {
        string name;
        address target; // address(0) when the implementation is not available
        bool packed; // storageAtPacked instead of storageAt
        bool inclusionOnly; // the library cannot prove absence and reverts instead
    }

    struct Case {
        string name;
        string file;
        uint256 index; // index into proof.storageProof
    }

    struct Proof {
        uint256 blockNumber;
        bytes32 stateRoot;
        address account;
        bytes32 slot;
        uint256 value;
        bytes[] accountProof;
        bytes[] storageProof;
    }

    struct Outcome {
        bool ok;
        uint256 value;
        string err;
    }

    struct Row {
        string status;
        string note;
        uint256 executionGas;
        uint256 calldataBytes;
        uint256 calldataGas;
        uint256 txGas;
    }

    Impl[] internal impls;

    function setUp() public {
        impls.push(Impl("optimism", vm.deployCode("OptimismStateReader.sol:OptimismStateReader"), false, true));
        impls.push(Impl("lido", vm.deployCode("LidoStateReader.sol:LidoStateReader"), false, false));
        impls.push(Impl("lido-0.8", vm.deployCode("LidoStateReader08.sol:LidoStateReader08"), false, false));
        address fe = _deployFe();
        impls.push(Impl("ferrotype", fe, false, false));
        impls.push(Impl("ferrotype-packed", fe, true, false));
    }

    // ------------------------------------------------------------------------------------------
    // Gas
    // ------------------------------------------------------------------------------------------

    function test_gas() public {
        Case[] memory cases = _cases();
        string memory rows = "";
        uint256 n;
        for (uint256 c = 0; c < cases.length; ++c) {
            Proof memory p = _load(cases[c]);
            for (uint256 i = 0; i < impls.length; ++i) {
                Row memory r = _measure(impls[i], cases[c], p);
                string memory row = _gasRow(string.concat("gas", vm.toString(n)), impls[i], cases[c], p, r);
                rows = n == 0 ? row : string.concat(rows, ",", row);
                ++n;
                _logGas(impls[i].name, cases[c].name, r);
            }
        }
        vm.writeJson(string.concat('{"results":[', rows, "]}"), GAS_JSON);
    }

    function _measure(Impl memory impl, Case memory c, Proof memory p) internal view returns (Row memory r) {
        bytes memory data = _calldata(impl, p);
        uint256 tokens = _calldataTokens(data);
        r.calldataBytes = data.length;
        r.calldataGas = GAS_PER_TOKEN * tokens;

        if (impl.target == address(0)) {
            r.status = "skipped";
            r.note = "no ../out/StateReader.bin";
            return r;
        }

        Outcome memory o = _call(impl.target, data);
        if (!o.ok) {
            // An inclusion-only library may refuse an exclusion proof. Anything else is a failure.
            if (impl.inclusionOnly && p.value == 0) {
                r.status = "unsupported";
                r.note = o.err;
                return r;
            }
            revert(string.concat(impl.name, " rejected the valid proof ", c.name, ": ", o.err));
        }
        vm.assertEq(o.value, p.value, string.concat(impl.name, " returned the wrong value for ", c.name));

        r.status = "ok";
        r.executionGas = _gasOf(impl.target, data) - _gasOf(NO_CODE, data);
        uint256 standard = r.calldataGas + r.executionGas;
        uint256 floor = FLOOR_GAS_PER_TOKEN * tokens;
        r.txGas = TX_BASE_GAS + (standard > floor ? standard : floor);
    }

    /// @dev Gas consumed by a STATICCALL to `target`, measured on the second of two identical
    ///      calls so the target is warm, as a transaction's own `to` is.
    function _gasOf(address target, bytes memory data) internal view returns (uint256 used) {
        assembly ("memory-safe") {
            pop(staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0))
            let before := gas()
            pop(staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0))
            used := sub(before, gas())
        }
    }

    function _gasRow(string memory key, Impl memory impl, Case memory c, Proof memory p, Row memory r)
        internal
        returns (string memory json)
    {
        vm.serializeString(key, "implementation", impl.name);
        vm.serializeString(key, "case", c.name);
        vm.serializeString(key, "status", r.status);
        vm.serializeUint(key, "block", p.blockNumber);
        vm.serializeString(key, "account", vm.toString(p.account));
        vm.serializeString(key, "slot", vm.toString(p.slot));
        vm.serializeString(key, "value", vm.toString(bytes32(p.value)));
        vm.serializeUint(key, "account_proof_nodes", p.accountProof.length);
        vm.serializeUint(key, "storage_proof_nodes", p.storageProof.length);
        if (bytes(r.note).length != 0) vm.serializeString(key, "note", r.note);
        if (r.executionGas != 0) {
            vm.serializeUint(key, "execution_gas", r.executionGas);
            vm.serializeUint(key, "tx_gas", r.txGas);
        }
        vm.serializeUint(key, "calldata_bytes", r.calldataBytes);
        json = vm.serializeUint(key, "calldata_gas", r.calldataGas);
    }

    function _logGas(string memory impl, string memory c, Row memory r) internal view {
        string memory gasText = r.executionGas != 0
            ? string.concat("exec ", vm.toString(r.executionGas), " gas, tx ", vm.toString(r.txGas), " gas")
            : string.concat(r.status, bytes(r.note).length != 0 ? string.concat(" (", r.note, ")") : "");
        console.log(
            string.concat(
                _pad(impl, 18),
                _pad(c, 26),
                _pad(gasText, 36),
                " calldata ",
                vm.toString(r.calldataBytes),
                " B / ",
                vm.toString(r.calldataGas),
                " gas"
            )
        );
    }

    // ------------------------------------------------------------------------------------------
    // Soundness: every verifier must revert on a broken proof
    // ------------------------------------------------------------------------------------------

    string[4] internal MUTATIONS =
        ["wrong-state-root", "tampered-storage-leaf", "truncated-storage-proof", "truncated-account-proof"];

    function test_rejectsInvalidProofs() public {
        Case memory c = Case("usdc-holder", "usdc.json", 1);
        string memory rows = "";
        uint256 n;
        for (uint256 m = 0; m < MUTATIONS.length; ++m) {
            for (uint256 i = 0; i < impls.length; ++i) {
                Impl memory impl = impls[i];
                Proof memory bad = _mutate(_load(c), m);
                string memory key = string.concat("snd", vm.toString(n));
                vm.serializeString(key, "implementation", impl.name);
                vm.serializeString(key, "case", c.name);
                vm.serializeString(key, "mutation", MUTATIONS[m]);

                string memory outcome;
                if (impl.target == address(0)) {
                    outcome = "skipped";
                } else {
                    Outcome memory o = _call(impl.target, _calldata(impl, bad));
                    if (o.ok) {
                        outcome = "accepted";
                        vm.serializeString(key, "value", vm.toString(bytes32(o.value)));
                    } else {
                        outcome = "rejected";
                        vm.serializeString(key, "note", o.err);
                    }
                    console.log(
                        string.concat(
                            _pad(impl.name, 18),
                            _pad(MUTATIONS[m], 26),
                            outcome,
                            o.ok ? string.concat(", returned ", vm.toString(o.value)) : string.concat(" (", o.err, ")")
                        )
                    );
                    if (o.ok) {
                        if (!_knownAcceptance(impl.name, m)) {
                            revert(string.concat(impl.name, " accepted a broken proof: ", MUTATIONS[m]));
                        }
                        vm.assertEq(o.value, 0, "a known acceptance should forge absence, i.e. return 0");
                    }
                }
                string memory row = vm.serializeString(key, "outcome", outcome);
                rows = n == 0 ? row : string.concat(rows, ",", row);
                ++n;
            }
        }
        vm.writeJson(string.concat('{"results":[', rows, "]}"), SOUNDNESS_JSON);
    }

    /// @dev Breaks a valid proof in one of four ways. `p` is a fresh copy and is modified in place.
    function _mutate(Proof memory p, uint256 m) internal pure returns (Proof memory) {
        if (m == 0) {
            p.stateRoot ^= bytes32(uint256(1));
        } else if (m == 1) {
            bytes memory leaf = p.storageProof[p.storageProof.length - 1];
            leaf[leaf.length - 1] ^= 0x01;
        } else if (m == 2) {
            p.storageProof = _dropLast(p.storageProof);
        } else {
            // Stop the account proof one node early and send no storage proof at all.
            p.accountProof = _dropLast(p.accountProof);
            p.storageProof = new bytes[](0);
        }
        return p;
    }

    /// @dev Broken proofs a vendored library is known to accept. Lido's MerklePatriciaProofVerifier
    ///      (both builds) treats a proof that stops right after a branch node as a proof of
    ///      absence: the loop runs out of nodes and returns empty bytes, which StateProofVerifier
    ///      reads as "slot absent" (value 0) or "account absent". Any other acceptance fails here.
    function _knownAcceptance(string memory impl, uint256 m) internal pure returns (bool) {
        bool lido = keccak256(bytes(impl)) == keccak256("lido") || keccak256(bytes(impl)) == keccak256("lido-0.8");
        return lido && (m == 2 || m == 3);
    }

    // ------------------------------------------------------------------------------------------
    // Fixtures and calldata
    // ------------------------------------------------------------------------------------------

    function _cases() internal pure returns (Case[] memory cases) {
        cases = new Case[](5);
        cases[0] = Case("usdc-blacklisted-holder", "usdc.json", 0); // top bit of the slot set
        cases[1] = Case("usdc-holder", "usdc.json", 1);
        cases[2] = Case("weth-zero-slot", "weth.json", 0); // slot is 0: exclusion proof in the storage trie
        cases[3] = Case("absent-account", "absent-account.json", 0); // exclusion proof in the state trie
        cases[4] = Case("eoa-empty-storage", "eoa-empty-storage.json", 0); // empty storage root, empty storage proof
    }

    function _load(Case memory c) internal view returns (Proof memory p) {
        string memory json = vm.readFile(string.concat(FIXTURES, c.file));
        string memory sp = string.concat(".proof.storageProof[", vm.toString(c.index), "]");
        p.blockNumber = vm.parseJsonUint(json, ".block.number");
        p.stateRoot = vm.parseJsonBytes32(json, ".block.stateRoot");
        p.account = vm.parseJsonAddress(json, ".proof.address");
        p.accountProof = vm.parseJsonBytesArray(json, ".proof.accountProof");
        p.slot = vm.parseJsonBytes32(json, string.concat(sp, ".key"));
        p.value = vm.parseJsonUint(json, string.concat(sp, ".value"));
        p.storageProof = vm.parseJsonBytesArray(json, string.concat(sp, ".proof"));
        vm.assertTrue(
            keccak256(p.accountProof[0]) == p.stateRoot,
            string.concat(c.file, ": account proof does not start at the block's stateRoot")
        );
    }

    function _calldata(Impl memory impl, Proof memory p) internal pure returns (bytes memory) {
        if (impl.packed) {
            return abi.encodeCall(
                IStateReaderPacked.storageAtPacked,
                (p.stateRoot, p.account, p.slot, _concat(p.accountProof), _concat(p.storageProof))
            );
        }
        return abi.encodeCall(IStateReader.storageAt, (p.stateRoot, p.account, p.slot, p.accountProof, p.storageProof));
    }

    function _calldataTokens(bytes memory data) internal pure returns (uint256 tokens) {
        for (uint256 i = 0; i < data.length; ++i) {
            tokens += data[i] == 0 ? 1 : 4;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function _call(address target, bytes memory data) internal view returns (Outcome memory o) {
        bytes memory ret;
        (o.ok, ret) = target.staticcall(data);
        if (o.ok) {
            vm.assertEq(ret.length, 32, "storageAt must return one word");
            o.value = abi.decode(ret, (uint256));
        } else {
            o.err = _reason(ret);
        }
    }

    function _reason(bytes memory ret) internal pure returns (string memory) {
        if (ret.length == 0) return "revert()";
        if (ret.length < 4) return string.concat("revert ", vm.toString(ret));
        bytes4 selector = bytes4(ret);
        if (selector == 0x08c379a0) {
            bytes memory body = _slice(ret, 4);
            return abi.decode(body, (string));
        }
        if (selector == 0x4e487b71) return string.concat("panic ", vm.toString(_slice(ret, 4)));
        // Ferrotype: InvalidProof(uint8), with or without its selector.
        if (selector == 0xf7f9ec62 && ret.length == 36) return _invalidProof(abi.decode(_slice(ret, 4), (uint256)), "");
        if (ret.length == 32) return _invalidProof(abi.decode(ret, (uint256)), " (no selector)");
        return string.concat("revert data ", vm.toString(ret));
    }

    function _invalidProof(uint256 code, string memory suffix) internal pure returns (string memory) {
        string[6] memory names = ["?", "Malformed", "HashMismatch", "MissingNode", "ExtraNodes", "BadReference"];
        return string.concat(
            "InvalidProof(", vm.toString(code), ") ", code < names.length ? names[code] : "?", suffix
        );
    }

    function _deployFe() internal returns (address fe) {
        // forge cannot resolve the ../out permission until that directory exists, and then
        // isFile reverts instead of returning false. Both mean: no Fe build yet.
        bool found;
        try vm.isFile(FE_BIN) returns (bool isFile) {
            found = isFile;
        } catch {}
        if (!found) {
            console.log(string.concat("ferrotype: ", FE_BIN, " not found, skipping the Fe rows"));
            return address(0);
        }
        string memory text = vm.trim(vm.readFile(FE_BIN));
        if (!_startsWith0x(text)) text = string.concat("0x", text);
        bytes memory code = vm.parseBytes(text);
        assembly ("memory-safe") {
            fe := create(0, add(code, 0x20), mload(code))
        }
        if (fe == address(0) || fe.code.length == 0) {
            // Not init code after all: install the bytes as runtime code.
            fe = address(uint160(uint256(keccak256("ferrotype.StateReader"))));
            vm.etch(fe, code);
            console.log("ferrotype: StateReader.bin did not run as init code; installed it as runtime code");
        }
        vm.label(fe, "ferrotype");
    }

    function _concat(bytes[] memory nodes) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < nodes.length; ++i) {
            out = bytes.concat(out, nodes[i]);
        }
    }

    function _dropLast(bytes[] memory nodes) internal pure returns (bytes[] memory out) {
        out = new bytes[](nodes.length - 1);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = nodes[i];
        }
    }

    function _slice(bytes memory b, uint256 start) internal pure returns (bytes memory) {
        return _slice(b, start, b.length - start);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = b[start + i];
        }
    }

    function _startsWith0x(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        return b.length >= 2 && b[0] == "0" && (b[1] == "x" || b[1] == "X");
    }

    function _pad(string memory s, uint256 width) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= width) return string.concat(s, " ");
        bytes memory spaces = new bytes(width - b.length);
        for (uint256 i = 0; i < spaces.length; ++i) {
            spaces[i] = " ";
        }
        return string.concat(s, string(spaces));
    }
}
