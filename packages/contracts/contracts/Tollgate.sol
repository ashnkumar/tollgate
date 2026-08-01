// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  Tollgate — a marketplace for AI services billed per call.
/// @notice A provider lists a service together with an on-chain *rate card*. A buyer
///         escrows the worst-case price for one call, the service runs, and the call
///         settles against actual usage. Whatever the buyer over-escrowed comes back.
///
/// @dev The design problem this contract exists to solve:
///
///      An AI call has variable cost (tokens in, tokens out) but a buyer wants a
///      price they agreed to *before* the call runs. Those two facts are reconciled
///      here by splitting price into two moments:
///
///        1. `quote()` — computed on-chain from the provider's published rate card and
///           the exact input size. Bounded above by `maxOutputTokens`, so it is the
///           worst case, not an estimate. The buyer escrows exactly this.
///        2. `settleCall()` — the settler reports the *token counts* it observed. The
///           price is recomputed here, from the rate card the call was funded under (a
///           copy frozen into the call, not the provider's live one). The settler never
///           names a price, so it cannot invent one, and `settle` reverts if the
///           computed cost exceeds what the buyer escrowed.
///
///      What the settler can still do is misreport usage, bounded by the escrow. That
///      is an honest limitation of metering off-chain work on-chain: nothing here can
///      verify a token count. What the contract does guarantee is that a buyer never
///      pays a wei more than the quote they approved, and can always `reclaimCall()`
///      if the settler simply disappears.
///
///      Refunds and earnings both accrue to `balances` rather than being pushed. For
///      per-call payments this matters: a push refund can cost more gas than it
///      returns. Pull-settlement also keeps `settleCall` free of external calls.
contract Tollgate {
    // ─────────────────────────────────────────── types ──

    struct Service {
        address provider; //          receives earnings
        uint32 maxOutputTokens; //    hard ceiling on one call's output; bounds the quote
        bool active;
        address settler; //           may settle calls for this service (the provider's server)
        uint128 baseFeeWei; //        charged per call regardless of size
        uint128 perInputTokenWei;
        uint128 perOutputTokenWei;
    }

    /// @dev A call carries its own copy of the terms it was funded under.
    ///
    ///      Reading them back off the live `Service` at settlement time looks equivalent
    ///      and is not: the provider can edit a service while a call is in flight. Raising
    ///      the rates then makes settlement exceed the escrow, lowering `maxOutputTokens`
    ///      makes the real output unreportable, and changing `settler` locks out the
    ///      machine that actually did the work. In each case the escrow still protects the
    ///      buyer from being overcharged, but the call becomes impossible to settle — the
    ///      buyer's funds sit until `CALL_TIMEOUT` and the provider earns nothing.
    ///
    ///      Snapshotting costs three extra storage slots per call and makes a funded call
    ///      immune to anything the provider does afterwards.
    struct Call {
        bytes32 serviceId;
        address buyer;
        uint32 quotedInputTokens;
        uint32 maxOutputTokens;
        bool settled;
        address provider;
        uint64 expiresAt;
        address settler;
        uint128 escrowWei;
        uint128 baseFeeWei;
        uint128 perInputTokenWei;
        uint128 perOutputTokenWei;
    }

    // ─────────────────────────────────────────── state ──

    /// @notice Platform cut, in basis points (100 = 1%). Fixed at deploy.
    uint16 public immutable feeBps;

    /// @notice Receives the platform cut. Fixed at deploy.
    address public immutable treasury;

    /// @notice How long a buyer's escrow can sit unsettled before they may reclaim it.
    uint64 public constant CALL_TIMEOUT = 1 hours;

    uint16 private constant BPS_DENOMINATOR = 10_000;

    mapping(bytes32 => Service) public services;
    mapping(bytes32 => Call) public calls;

    /// @notice Withdrawable balance. Providers' earnings, buyers' refunds, and the
    ///         platform cut all land here.
    mapping(address => uint256) public balances;

    // ────────────────────────────────────────── events ──

    event ServiceRegistered(
        bytes32 indexed serviceId,
        address indexed provider,
        address settler,
        uint128 baseFeeWei,
        uint128 perInputTokenWei,
        uint128 perOutputTokenWei,
        uint32 maxOutputTokens
    );
    event ServiceUpdated(
        bytes32 indexed serviceId,
        address settler,
        uint128 baseFeeWei,
        uint128 perInputTokenWei,
        uint128 perOutputTokenWei,
        uint32 maxOutputTokens
    );
    event ServiceActiveSet(bytes32 indexed serviceId, bool active);

    event CallOpened(
        bytes32 indexed callId,
        bytes32 indexed serviceId,
        address indexed buyer,
        uint32 quotedInputTokens,
        uint256 escrowWei,
        uint64 expiresAt
    );
    event CallSettled(
        bytes32 indexed callId,
        bytes32 indexed serviceId,
        address indexed buyer,
        uint32 inputTokens,
        uint32 outputTokens,
        uint256 costWei,
        uint256 providerWei,
        uint256 feeWei,
        uint256 refundWei
    );
    event CallRefunded(bytes32 indexed callId, address indexed buyer, uint256 amountWei, string reason);
    event Withdrawn(address indexed account, uint256 amountWei);

    // ────────────────────────────────────────── errors ──

    error ServiceExists();
    error NoSuchService();
    error NotProvider();
    error NotSettler();
    error NotBuyer();
    error ServiceInactive();
    error CallExists();
    error NoSuchCall();
    error AlreadySettled();
    error Underfunded(uint256 required, uint256 supplied);
    error CostExceedsEscrow(uint256 cost, uint256 escrow);
    error OutputOverCap(uint32 outputTokens, uint32 maxOutputTokens);
    error NotYetExpired(uint64 expiresAt);
    error NothingToWithdraw();
    error TransferFailed();
    error InvalidFee();
    error ZeroAddress();

    // ───────────────────────────────────── constructor ──

    constructor(address treasury_, uint16 feeBps_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > BPS_DENOMINATOR) revert InvalidFee();
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ──────────────────────────────────────── services ──

    /// @notice List a service. `msg.sender` becomes the provider and is paid for calls.
    /// @param  settler_ address permitted to settle this service's calls — the provider's
    ///         server. Kept separate from `provider` so the machine holding a hot key
    ///         cannot move funds; it can only report usage.
    function registerService(
        bytes32 serviceId,
        address settler_,
        uint128 baseFeeWei,
        uint128 perInputTokenWei,
        uint128 perOutputTokenWei,
        uint32 maxOutputTokens
    ) external {
        if (serviceId == bytes32(0)) revert NoSuchService();
        if (settler_ == address(0)) revert ZeroAddress();
        if (services[serviceId].provider != address(0)) revert ServiceExists();

        services[serviceId] = Service({
            provider: msg.sender,
            maxOutputTokens: maxOutputTokens,
            active: true,
            settler: settler_,
            baseFeeWei: baseFeeWei,
            perInputTokenWei: perInputTokenWei,
            perOutputTokenWei: perOutputTokenWei
        });

        emit ServiceRegistered(
            serviceId, msg.sender, settler_, baseFeeWei, perInputTokenWei, perOutputTokenWei, maxOutputTokens
        );
    }

    /// @notice Change a service's rate card. Affects only calls opened after this point —
    ///         calls already in flight carry their own copy of the terms and settle against
    ///         that, so changing rates, the ceiling, or the settler cannot disturb them.
    function updateService(
        bytes32 serviceId,
        address settler_,
        uint128 baseFeeWei,
        uint128 perInputTokenWei,
        uint128 perOutputTokenWei,
        uint32 maxOutputTokens
    ) external {
        Service storage s = _ownedService(serviceId);
        if (settler_ == address(0)) revert ZeroAddress();

        s.settler = settler_;
        s.baseFeeWei = baseFeeWei;
        s.perInputTokenWei = perInputTokenWei;
        s.perOutputTokenWei = perOutputTokenWei;
        s.maxOutputTokens = maxOutputTokens;

        emit ServiceUpdated(serviceId, settler_, baseFeeWei, perInputTokenWei, perOutputTokenWei, maxOutputTokens);
    }

    /// @notice Take a service off the market, or put it back. Calls already open are
    ///         unaffected and can still settle — deactivating must not strand escrow.
    function setServiceActive(bytes32 serviceId, bool active) external {
        Service storage s = _ownedService(serviceId);
        s.active = active;
        emit ServiceActiveSet(serviceId, active);
    }

    // ─────────────────────────────────────────── quote ──

    /// @notice Worst-case price of one call, in wei. This is the number the buyer escrows.
    /// @dev    Anyone can call this, which is the point: a buyer does not have to trust the
    ///         server's quote, they can recompute it from the published rate card.
    function quote(bytes32 serviceId, uint32 inputTokens) public view returns (uint256) {
        Service memory s = services[serviceId];
        if (s.provider == address(0)) revert NoSuchService();
        return _cost(s.baseFeeWei, s.perInputTokenWei, s.perOutputTokenWei, inputTokens, s.maxOutputTokens);
    }

    // ─────────────────────────────────────────── calls ──

    /// @notice Escrow the worst-case price for one call.
    /// @param  callId unique, unpredictable id minted by the caller.
    /// @param  inputTokens exact input size the quote was computed for.
    function openCall(bytes32 callId, bytes32 serviceId, uint32 inputTokens) external payable {
        Service memory s = services[serviceId];
        if (s.provider == address(0)) revert NoSuchService();
        if (!s.active) revert ServiceInactive();
        if (calls[callId].buyer != address(0)) revert CallExists();

        uint256 required = _cost(s.baseFeeWei, s.perInputTokenWei, s.perOutputTokenWei, inputTokens, s.maxOutputTokens);
        if (msg.value < required) revert Underfunded(required, msg.value);

        uint64 expiresAt = uint64(block.timestamp) + CALL_TIMEOUT;
        calls[callId] = Call({
            serviceId: serviceId,
            buyer: msg.sender,
            quotedInputTokens: inputTokens,
            // Terms frozen here. Nothing the provider does from now on can change what
            // this call costs, who may settle it, or whether it can be settled at all.
            maxOutputTokens: s.maxOutputTokens,
            settled: false,
            provider: s.provider,
            expiresAt: expiresAt,
            settler: s.settler,
            escrowWei: uint128(msg.value),
            baseFeeWei: s.baseFeeWei,
            perInputTokenWei: s.perInputTokenWei,
            perOutputTokenWei: s.perOutputTokenWei
        });

        emit CallOpened(callId, serviceId, msg.sender, inputTokens, msg.value, expiresAt);
    }

    /// @notice Settle a call against the usage actually observed.
    /// @dev    The settler reports token counts, never a price — price is recomputed here
    ///         from the on-chain rate card. Reverts rather than clamping if the result
    ///         exceeds the escrow, so a buyer can never be charged past their quote; it is
    ///         the provider's job to quote an input size it can honour.
    function settleCall(bytes32 callId, uint32 inputTokens, uint32 outputTokens) external {
        Call storage c = calls[callId];
        if (c.buyer == address(0)) revert NoSuchCall();
        if (c.settled) revert AlreadySettled();

        // Everything below reads the terms frozen at openCall, never the live service.
        if (msg.sender != c.settler) revert NotSettler();
        if (outputTokens > c.maxOutputTokens) revert OutputOverCap(outputTokens, c.maxOutputTokens);

        uint256 escrow = c.escrowWei;
        uint256 cost = _cost(c.baseFeeWei, c.perInputTokenWei, c.perOutputTokenWei, inputTokens, outputTokens);
        if (cost > escrow) revert CostExceedsEscrow(cost, escrow);

        c.settled = true;

        uint256 feeWei = (cost * feeBps) / BPS_DENOMINATOR;
        uint256 providerWei = cost - feeWei;
        uint256 refundWei = escrow - cost;

        balances[c.provider] += providerWei;
        if (feeWei > 0) balances[treasury] += feeWei;
        if (refundWei > 0) balances[c.buyer] += refundWei;

        emit CallSettled(
            callId, c.serviceId, c.buyer, inputTokens, outputTokens, cost, providerWei, feeWei, refundWei
        );
    }

    /// @notice Settle a call as failed — the whole escrow returns to the buyer.
    /// @dev    For when the upstream service errored. The provider earns nothing, which is
    ///         the correct incentive: a call that produced no output should cost nothing.
    function failCall(bytes32 callId, string calldata reason) external {
        Call storage c = calls[callId];
        if (c.buyer == address(0)) revert NoSuchCall();
        if (c.settled) revert AlreadySettled();
        if (msg.sender != c.settler) revert NotSettler();

        c.settled = true;
        balances[c.buyer] += c.escrowWei;

        emit CallRefunded(callId, c.buyer, c.escrowWei, reason);
    }

    /// @notice Take back escrow for a call nobody ever settled.
    /// @dev    Without this, a settler that goes offline locks the buyer's funds forever.
    function reclaimCall(bytes32 callId) external {
        Call storage c = calls[callId];
        if (c.buyer == address(0)) revert NoSuchCall();
        if (c.settled) revert AlreadySettled();
        if (msg.sender != c.buyer) revert NotBuyer();
        if (block.timestamp < c.expiresAt) revert NotYetExpired(c.expiresAt);

        c.settled = true;
        balances[c.buyer] += c.escrowWei;

        emit CallRefunded(callId, c.buyer, c.escrowWei, "expired");
    }

    // ───────────────────────────────────── withdrawals ──

    /// @notice Withdraw everything owed to `msg.sender`.
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: zero the balance before the external call.
        balances[msg.sender] = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, amount);
    }

    // ────────────────────────────────────── internals ──

    /// @dev Takes rates explicitly rather than a Service, so callers must be deliberate
    ///      about whether they are pricing against the live rate card (a new quote) or the
    ///      terms a call was funded under (settlement).
    function _cost(
        uint128 baseFeeWei,
        uint128 perInputTokenWei,
        uint128 perOutputTokenWei,
        uint32 inputTokens,
        uint32 outputTokens
    ) private pure returns (uint256) {
        // uint32 * uint128 tops out around 2**160 — no overflow risk in uint256.
        return uint256(baseFeeWei) + (uint256(inputTokens) * perInputTokenWei)
            + (uint256(outputTokens) * perOutputTokenWei);
    }

    function _ownedService(bytes32 serviceId) private view returns (Service storage s) {
        s = services[serviceId];
        if (s.provider == address(0)) revert NoSuchService();
        if (s.provider != msg.sender) revert NotProvider();
    }
}
