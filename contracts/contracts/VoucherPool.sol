// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./StreamAndRootRing.sol";
import "./IVerifiers.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// Stream + checkpoint variant of the voucher pool. See docs/gas-design.md
// §3b for the design and the rationale for splitting per-tx streaming from
// batched checkpointing.
contract VoucherPool {
    using StreamRingLib for StreamRingLib.State;

    // --- config ---
    IERC20 public immutable stablecoin;
    ICreateVerifier public immutable createVerifier;
    IAssignVerifier public immutable assignVerifier;
    IRedeemVerifier public immutable redeemVerifier;
    ICheckpointVerifier public immutable checkpointVerifier;
    address public admin;
    uint256 public immutable epochSize;
    uint256 public immutable genesisBlock;

    // --- stream + checkpoint state ---
    StreamRingLib.State internal state;

    // --- nullifiers, bucketed by expiry epoch ---
    mapping(uint32 => mapping(uint256 => bool)) public nullifiers;

    // --- operator registry + accounting ---
    mapping(address => bool) public isOperator;
    mapping(address => uint256) public credit;
    uint256 public deposited;
    uint256 public withdrawn;
    mapping(uint32 => uint256) public minted;
    mapping(uint32 => uint256) public spent;
    mapping(uint32 => uint256) public reclaimed;

    // --- events ---
    event VoucherCreated(uint256 indexed cm, uint256 value, uint32 expiryEpoch, uint32 leafIndex);
    event Assigned(
        uint256 indexed nullifier,
        uint32 indexed expiryEpoch,
        uint256 cmDest,
        uint256 cmChange,
        uint32 destLeafIndex,
        uint32 changeLeafIndex
    );
    event Redeemed(
        uint256 indexed nullifier,
        uint32 indexed expiryEpoch,
        address indexed operator,
        uint256 redeemValue,
        uint256 cmChange,
        uint32 changeLeafIndex
    );
    event Withdrawn(address indexed operator, uint256 amount);
    event OperatorRegistered(address indexed operator);
    event OperatorUnregistered(address indexed operator);
    event EpochReclaimed(uint32 indexed epoch, address indexed sink, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "pool/admin");
        _;
    }

    constructor(
        IERC20 _stablecoin,
        ICreateVerifier _create,
        IAssignVerifier _assign,
        IRedeemVerifier _redeem,
        ICheckpointVerifier _checkpoint,
        uint256 _epochSize
    ) {
        require(_epochSize > 0, "pool/epoch");
        stablecoin = _stablecoin;
        createVerifier = _create;
        assignVerifier = _assign;
        redeemVerifier = _redeem;
        checkpointVerifier = _checkpoint;
        admin = msg.sender;
        epochSize = _epochSize;
        genesisBlock = block.number;
        state.init();
    }

    // --- batched-checkpoint config ---
    // Max # of leaves per checkpoint extrinsic. Fixed in the circuit's
    // template instantiation; the contract enforces it before SNARK verify.
    // See issue #2 (batching) for the choice — 8 amortises fees ~6× vs B=1
    // at a ~50K-constraint cost (fits ptau-17 comfortably).
    uint32 public constant CHECKPOINT_BATCH_MAX = 8;
    uint256 internal constant DEPTH = 20;

    // --- views ---
    function currentEpoch() public view returns (uint32) {
        return uint32((block.number - genesisBlock) / epochSize);
    }

    function streamCount() external view returns (uint32) { return state.streamCount; }
    function streamAt(uint32 position) external view returns (uint256) { return state.streamAt(position); }
    function checkpointedRoot() external view returns (uint256) { return state.checkpointedRoot; }
    function checkpointedCount() external view returns (uint32) { return state.checkpointedCount; }
    function checkpointedFrontier() external view returns (uint256[DEPTH] memory) {
        return state.getFrontier();
    }
    function isKnownRoot(uint256 root) external view returns (bool) { return state.isKnownRoot(root); }
    function isNullifierSpent(uint32 epoch, uint256 nf) external view returns (bool) {
        return nullifiers[epoch][nf];
    }

    // --- create (buyer signs; permissionless) ---
    function buyAndCreate(
        uint256 cm,
        uint256 value,
        uint32 expiryEpoch,
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC
    ) external {
        require(value > 0, "pool/value");
        require(expiryEpoch > currentEpoch(), "pool/expired");

        uint[3] memory pubSignals = [cm, value, uint256(expiryEpoch)];
        require(createVerifier.verifyProof(pA, pB, pC, pubSignals), "pool/proof");

        require(
            stablecoin.transferFrom(msg.sender, address(this), value),
            "pool/transferFrom"
        );

        uint32 idx = state.appendStream(cm);
        deposited += value;
        minted[expiryEpoch] += value;

        emit VoucherCreated(cm, value, expiryEpoch, idx);
    }

    // --- assign (relayed for chat user) ---
    // Spend proofs bind to a checkpointed root (`root` ∈ knownRoots). The
    // new commitments cmDest + cmChange land in the stream and become
    // spendable after the next checkpoint.
    function assign(
        uint256 nullifier,
        uint32 expiryEpoch,
        uint256 cmDest,
        uint256 cmChange,
        uint256 root,
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC
    ) external {
        require(expiryEpoch >= currentEpoch(), "pool/expired");
        require(state.isKnownRoot(root), "pool/root");
        require(!nullifiers[expiryEpoch][nullifier], "pool/nullifier");

        uint[5] memory pubSignals = [root, nullifier, uint256(expiryEpoch), cmDest, cmChange];
        require(assignVerifier.verifyProof(pA, pB, pC, pubSignals), "pool/proof");

        nullifiers[expiryEpoch][nullifier] = true;
        uint32 destIdx = state.appendStream(cmDest);
        uint32 changeIdx = state.appendStream(cmChange);

        emit Assigned(nullifier, expiryEpoch, cmDest, cmChange, destIdx, changeIdx);
    }

    // --- redeem (relayed; operatorId in proof = credit recipient) ---
    function redeem(
        uint256 nullifier,
        uint32 expiryEpoch,
        uint256 redeemValue,
        uint256 cmChange,
        uint256 root,
        uint256 operatorId,
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC
    ) external {
        require(expiryEpoch >= currentEpoch(), "pool/expired");
        require(state.isKnownRoot(root), "pool/root");
        require(!nullifiers[expiryEpoch][nullifier], "pool/nullifier");

        address op = address(uint160(operatorId));
        require(isOperator[op], "pool/operator");

        uint[6] memory pubSignals = [
            root,
            nullifier,
            uint256(expiryEpoch),
            redeemValue,
            cmChange,
            operatorId
        ];
        require(redeemVerifier.verifyProof(pA, pB, pC, pubSignals), "pool/proof");

        nullifiers[expiryEpoch][nullifier] = true;
        uint32 changeIdx = state.appendStream(cmChange);
        credit[op] += redeemValue;
        spent[expiryEpoch] += redeemValue;

        emit Redeemed(nullifier, expiryEpoch, op, redeemValue, cmChange, changeIdx);
    }

    // --- checkpoint (permissionless; rolls stream → tree root) ---
    // Batched, frontier-aware. The SNARK proves that appending the
    // commitments at positions [oldCount..oldCount+count) to the tree at
    // (oldRoot, oldFrontier) yields (newRoot, newFrontier). The contract:
    //   - reads (oldRoot, oldFrontier, oldCount) from state — the prover
    //     can't fake them;
    //   - reads cms[0..count) from `state.commitments` and pads the tail
    //     to zero so the SNARK's fixed B_MAX matches what's on chain;
    //   - packs all of the above + caller-supplied newRoot/newFrontier
    //     into the verifier's `pubSignals` array (in the exact order the
    //     circuit declares).
    //
    // No on-chain time gating — anyone can submit at any time the chain
    // accepts. The 5-min cadence is a polite-primary scheduler convention
    // (tools/checkpoint.mjs), not a protocol invariant. See issue #3 for
    // the fallback-liveness rationale.
    function checkpoint(
        uint256 newRoot,
        uint256[DEPTH] calldata newFrontier,
        uint32 count,
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC
    ) external {
        uint32 oldCount = state.checkpointedCount;
        require(count >= 1, "ckp/no-progress");
        require(count <= CHECKPOINT_BATCH_MAX, "ckp/batch-size");
        uint32 newCount = oldCount + count;
        require(newCount <= state.streamCount, "ckp/future");
        require(newCount <= uint32(1 << DEPTH), "ckp/tree-full");

        uint256 oldRoot = state.checkpointedRoot;
        uint256[DEPTH] memory oldFrontier = state.getFrontier();

        uint[52] memory pubSignals;
        // Layout matches circuits/src/checkpoint.circom declaration order:
        //   [0]      oldRoot
        //   [1]      newRoot
        //   [2..21]  oldFrontier[0..19]
        //   [22..41] newFrontier[0..19]
        //   [42]     oldCount
        //   [43]     count
        //   [44..51] cms[0..7]
        pubSignals[0] = oldRoot;
        pubSignals[1] = newRoot;
        for (uint256 d = 0; d < DEPTH; d++) {
            pubSignals[2 + d] = oldFrontier[d];
            pubSignals[2 + DEPTH + d] = newFrontier[d];
        }
        pubSignals[2 + 2 * DEPTH]     = uint256(oldCount);
        pubSignals[2 + 2 * DEPTH + 1] = uint256(count);
        for (uint256 i = 0; i < CHECKPOINT_BATCH_MAX; i++) {
            // i < count: real leaf from the stream. i >= count: zero pad.
            pubSignals[2 + 2 * DEPTH + 2 + i] =
                i < count ? state.streamAt(oldCount + uint32(i)) : 0;
        }
        require(checkpointVerifier.verifyProof(pA, pB, pC, pubSignals), "ckp/proof");

        state.applyCheckpoint(newRoot, newCount, newFrontier);
        emit StreamRingLib.Checkpointed(oldRoot, newRoot, oldCount, newCount);
    }

    // --- operator withdraw ---
    function withdraw(uint256 amount) external {
        uint256 c = credit[msg.sender];
        require(c >= amount, "pool/credit");
        credit[msg.sender] = c - amount;
        withdrawn += amount;
        require(stablecoin.transfer(msg.sender, amount), "pool/transfer");
        emit Withdrawn(msg.sender, amount);
    }

    // --- admin ---
    function setAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }

    function registerOperator(address op) external onlyAdmin {
        isOperator[op] = true;
        emit OperatorRegistered(op);
    }

    function unregisterOperator(address op) external onlyAdmin {
        isOperator[op] = false;
        emit OperatorUnregistered(op);
    }

    function reclaimEpoch(uint32 epoch, address sink) external onlyAdmin {
        require(currentEpoch() >= epoch + 2, "pool/early");
        uint256 unspent = minted[epoch] - spent[epoch] - reclaimed[epoch];
        if (unspent == 0) return;
        reclaimed[epoch] += unspent;
        withdrawn += unspent;
        require(stablecoin.transfer(sink, unspent), "pool/transfer");
        emit EpochReclaimed(epoch, sink, unspent);
    }
}
