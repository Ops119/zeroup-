// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoseidonT3} from "./lib/PoseidonT3.sol";

interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[5] calldata publicSignals
    ) external view returns (bool);
}

interface IScreener {
    function isBlocked(address account) external view returns (bool);
}

interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title ZeroupPool
/// @notice Single-asset shielded pool. Deposits add a note commitment to a
/// Poseidon Merkle tree; a withdrawal proves ownership of some note without
/// revealing which, releases part of it and re-commits the change. Nothing in
/// the pool is custodial: only a valid proof moves funds, and anyone can
/// withdraw to their own address at any time.
contract ZeroupPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_VALUE = 2 ** 128;
    uint32 public constant LEVELS = 20;
    uint32 public constant ROOT_HISTORY_SIZE = 64;

    IERC20 public immutable token;
    IWithdrawVerifier public immutable verifier;
    IScreener public immutable screener;

    // Incremental Merkle tree (Tornado-style) over Poseidon(left, right).
    uint256[LEVELS] public zeros;
    uint256[LEVELS] public filledSubtrees;
    uint256[ROOT_HISTORY_SIZE] public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    mapping(uint256 => bool) public nullifierSpent;

    event Deposit(
        address indexed depositor, uint256 indexed commitment, uint32 leafIndex, uint256 value, bytes encryptedNote
    );
    event Withdrawal(
        uint256 indexed nullifierHash,
        address indexed recipient,
        address indexed relayer,
        uint256 withdrawnValue,
        uint256 fee,
        uint256 newCommitment,
        uint32 leafIndex,
        bytes encryptedNote
    );

    error Blocked(address account);
    error InvalidValue();
    error InvalidField();
    error UnknownRoot();
    error NullifierSpent();
    error FeeTooHigh();
    error InvalidProof();
    error TreeFull();
    error NonceMismatch();

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct WithdrawRequest {
        uint256 root;
        uint256 nullifierHash;
        uint256 withdrawnValue;
        uint256 newCommitment;
        address recipient;
        address relayer;
        uint256 fee;
        bytes encryptedNote;
    }

    constructor(IERC20 token_, IWithdrawVerifier verifier_, IScreener screener_) {
        token = token_;
        verifier = verifier_;
        screener = screener_;
        uint256 z = 0;
        for (uint32 i = 0; i < LEVELS; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = PoseidonT3.hash([z, z]);
        }
        roots[0] = z;
    }

    // ---------------------------------------------------------------- deposits

    /// @notice Deposit with a standard ERC-20 approval (depositor pays gas).
    function deposit(uint256 value, uint256 precommitment, bytes calldata encryptedNote)
        external
        nonReentrant
        returns (uint256 commitment)
    {
        _screen(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), value);
        commitment = _recordDeposit(msg.sender, value, precommitment, encryptedNote);
    }

    /// @notice Gasless deposit: the depositor signs an EIP-3009
    /// ReceiveWithAuthorization and a sponsor submits it. The authorization
    /// nonce must commit to the note so a front-runner cannot swap in their own
    /// precommitment.
    function depositWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 precommitment,
        bytes calldata encryptedNote
    ) external nonReentrant returns (uint256 commitment) {
        _screen(from);
        if (nonce != depositNonce(precommitment, encryptedNote)) revert NonceMismatch();
        IEIP3009(address(token)).receiveWithAuthorization(
            from, address(this), value, validAfter, validBefore, nonce, v, r, s
        );
        commitment = _recordDeposit(from, value, precommitment, encryptedNote);
    }

    function depositNonce(uint256 precommitment, bytes calldata encryptedNote) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), precommitment, keccak256(encryptedNote)));
    }

    function _recordDeposit(address from, uint256 value, uint256 precommitment, bytes calldata encryptedNote)
        private
        returns (uint256 commitment)
    {
        if (value == 0 || value >= MAX_VALUE) revert InvalidValue();
        if (precommitment >= FIELD_SIZE) revert InvalidField();
        commitment = PoseidonT3.hash([value, precommitment]);
        uint32 index = _insert(commitment);
        emit Deposit(from, commitment, index, value, encryptedNote);
    }

    // ------------------------------------------------------------- withdrawals

    function withdraw(Proof calldata proof, WithdrawRequest calldata req) external nonReentrant {
        if (nullifierSpent[req.nullifierHash]) revert NullifierSpent();
        if (!isKnownRoot(req.root)) revert UnknownRoot();
        if (req.withdrawnValue >= MAX_VALUE) revert InvalidValue();
        if (req.fee > req.withdrawnValue) revert FeeTooHigh();
        if (req.newCommitment >= FIELD_SIZE || req.nullifierHash >= FIELD_SIZE) revert InvalidField();
        _screen(req.recipient);

        uint256[5] memory pub = [
            req.root,
            req.nullifierHash,
            req.withdrawnValue,
            req.newCommitment,
            withdrawContext(req.recipient, req.relayer, req.fee, req.encryptedNote)
        ];
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, pub)) revert InvalidProof();

        nullifierSpent[req.nullifierHash] = true;
        uint32 index = _insert(req.newCommitment);

        emit Withdrawal(
            req.nullifierHash,
            req.recipient,
            req.relayer,
            req.withdrawnValue,
            req.fee,
            req.newCommitment,
            index,
            req.encryptedNote
        );

        uint256 net = req.withdrawnValue - req.fee;
        if (net > 0) token.safeTransfer(req.recipient, net);
        if (req.fee > 0) token.safeTransfer(req.relayer, req.fee);
    }

    /// @notice Public input binding a proof to where the money goes.
    function withdrawContext(address recipient, address relayer, uint256 fee, bytes calldata encryptedNote)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(abi.encode(block.chainid, address(this), recipient, relayer, fee, keccak256(encryptedNote)))
        ) % FIELD_SIZE;
    }

    // ------------------------------------------------------------- merkle tree

    function _insert(uint256 leaf) private returns (uint32 index) {
        index = nextIndex;
        if (index >= uint32(2) ** LEVELS) revert TreeFull();
        uint32 cur = index;
        uint256 hash = leaf;
        for (uint32 i = 0; i < LEVELS; i++) {
            if (cur % 2 == 0) {
                filledSubtrees[i] = hash;
                hash = PoseidonT3.hash([hash, zeros[i]]);
            } else {
                hash = PoseidonT3.hash([filledSubtrees[i], hash]);
            }
            cur /= 2;
        }
        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = hash;
        nextIndex = index + 1;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        do {
            if (roots[i] == root) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != currentRootIndex);
        return false;
    }

    function getLastRoot() external view returns (uint256) {
        return roots[currentRootIndex];
    }

    function _screen(address account) private view {
        if (screener.isBlocked(account)) revert Blocked(account);
    }
}
