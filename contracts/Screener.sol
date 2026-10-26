// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Deposit and withdrawal screening list. In production the owner is a
/// compliance multisig fed by a sanctions/stolen-funds provider; the pool,
/// sponsor and facilitator all consult it.
contract Screener is Ownable {
    mapping(address => bool) public isBlocked;

    event BlockedSet(address indexed account, bool blocked, string reason);

    constructor(address owner_) Ownable(owner_) {}

    function setBlocked(address[] calldata accounts, bool blocked, string calldata reason) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            isBlocked[accounts[i]] = blocked;
            emit BlockedSet(accounts[i], blocked, reason);
        }
    }
}
