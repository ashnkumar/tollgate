// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITollgate {
    function openCall(bytes32 callId, bytes32 serviceId, uint32 inputTokens) external payable;
    function withdraw() external;
    function withdrawTo(address payable recipient) external;
}

/// @title A buyer that cannot be paid directly
/// @notice Test fixture. It has no `receive` and no payable fallback, so a plain native
///         transfer to it reverts — which is what a multisig, a timelock, or most
///         contracts look like from the paying side.
/// @dev Exists to prove that a balance credited to such an account is still reachable.
///      Tollgate lets a buyer, a provider or the treasury be a contract, so without
///      `withdrawTo` those balances would be correctly recorded and permanently stuck.
contract RejectsPayment {
    ITollgate private immutable tollgate;

    /// @dev Funded at construction, because it cannot be sent anything afterwards.
    constructor(ITollgate tollgate_) payable {
        tollgate = tollgate_;
    }

    function open(bytes32 callId, bytes32 serviceId, uint32 inputTokens, uint256 value) external {
        tollgate.openCall{value: value}(callId, serviceId, inputTokens);
    }

    function pull() external {
        tollgate.withdraw();
    }

    function pullTo(address payable recipient) external {
        tollgate.withdrawTo(recipient);
    }
}
