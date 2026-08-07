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
///      Two things are required to make that first guarantee literal rather than
///      approximate, and both were missing from an earlier version of this contract:
///
///        - The escrow is the quote, not whatever was sent. Accepting `msg.value` as the
///          escrow made an overfunded call settleable at the larger number, so the
///          ceiling a buyer could actually be charged to was their own transfer rather
///          than the price they agreed. The surplus is credited back immediately.
///        - The buyer commits to the *formula*, not only to the total. Rates live in
///          mutable storage, so a provider could change the rate card between the buyer
///          reading `quote()` and their `openCall` mining — keeping the same total for
///          that one input size while moving the cost of a short answer up to the cap.
///          `openCall` takes the hash of the terms the buyer priced against and reverts
///          if the live card no longer matches.
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
    ///      immune to anything the provider does afterward.
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
    /// @param account The account whose balance was drawn down.
    /// @param recipient Where it was paid; the same as `account` for a plain `withdraw()`.
    event Withdrawn(address indexed account, address indexed recipient, uint256 amountWei);

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
    error TermsChanged(bytes32 expected, bytes32 actual);
    error QuoteTooLarge(uint256 required);
    error CostExceedsEscrow(uint256 cost, uint256 escrow);
    error OutputOverCap(uint32 outputTokens, uint32 maxOutputTokens);
    error InputOverQuote(uint32 inputTokens, uint32 quotedInputTokens);
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

    /// @notice Hash of every term `quote()` is computed from, plus who may be paid and who
    ///         may settle. A buyer passes this to `openCall` to commit to the rate card
    ///         they actually read.
    /// @dev    A total is not a rate card. Two different formulas can produce the same
    ///         number for one input size and diverge everywhere else — moving `baseFeeWei`
    ///         up and `perOutputTokenWei` down keeps a 254-token quote identical while
    ///         making every short answer cost the full ceiling. Committing to the hash is
    ///         what makes "the buyer checked the formula" true rather than nearly true.
    function termsHash(bytes32 serviceId) public view returns (bytes32) {
        Service memory s = services[serviceId];
        if (s.provider == address(0)) revert NoSuchService();
        return _termsHash(serviceId, s);
    }

    // ─────────────────────────────────────────── calls ──

    /// @notice Escrow the worst-case price for one call.
    /// @param  callId unique, unpredictable id minted by the caller.
    /// @param  inputTokens exact input size the quote was computed for.
    /// @param  expectedTerms `termsHash(serviceId)` as the buyer read it. Reverts if the
    ///         provider has changed the rate card since.
    /// @dev    Overfunding is allowed and does not raise the ceiling: the escrow recorded
    ///         is the quote, and anything above it is credited straight back to the buyer's
    ///         withdrawable balance. Recording `msg.value` instead would have let a buyer
    ///         who rounded up be settled at the rounded-up figure.
    function openCall(bytes32 callId, bytes32 serviceId, uint32 inputTokens, bytes32 expectedTerms)
        external
        payable
    {
        Service memory s = services[serviceId];
        if (s.provider == address(0)) revert NoSuchService();
        if (!s.active) revert ServiceInactive();
        if (calls[callId].buyer != address(0)) revert CallExists();

        bytes32 actualTerms = _termsHash(serviceId, s);
        if (actualTerms != expectedTerms) revert TermsChanged(expectedTerms, actualTerms);

        uint256 required = _cost(s.baseFeeWei, s.perInputTokenWei, s.perOutputTokenWei, inputTokens, s.maxOutputTokens);
        if (msg.value < required) revert Underfunded(required, msg.value);
        // The escrow is stored narrow to keep a Call in four slots. A rate card extreme
        // enough to price past that is rejected outright rather than silently truncated,
        // which would put the difference outside every balance the contract can pay out.
        if (required > type(uint128).max) revert QuoteTooLarge(required);

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
            escrowWei: uint128(required),
            baseFeeWei: s.baseFeeWei,
            perInputTokenWei: s.perInputTokenWei,
            perOutputTokenWei: s.perOutputTokenWei
        });

        unchecked {
            uint256 surplus = msg.value - required;
            if (surplus > 0) balances[msg.sender] += surplus;
        }

        emit CallOpened(callId, serviceId, msg.sender, inputTokens, required, expiresAt);
    }

    /// @notice Settle a call against the usage actually observed.
    /// @dev    The settler reports token counts, never a price — price is recomputed here
    ///         from the rate card frozen into the call. Both counts are bounded by what the
    ///         quote was priced for, and the total is bounded by the escrow, which is the
    ///         quote. Reverting rather than clamping keeps the failure loud; it is the
    ///         provider's job to quote an input size it can honor.
    function settleCall(bytes32 callId, uint32 inputTokens, uint32 outputTokens) external {
        Call storage c = calls[callId];
        if (c.buyer == address(0)) revert NoSuchCall();
        if (c.settled) revert AlreadySettled();

        // Everything below reads the terms frozen at openCall, never the live service.
        if (msg.sender != c.settler) revert NotSettler();
        if (outputTokens > c.maxOutputTokens) revert OutputOverCap(outputTokens, c.maxOutputTokens);
        // Both counts are capped at what the quote was priced for. Bounding the total
        // against the escrow is not enough on its own: without this, a settler could
        // report more input than was quoted and trade it against unused output budget,
        // charging for work the buyer's price was never computed from.
        if (inputTokens > c.quotedInputTokens) revert InputOverQuote(inputTokens, c.quotedInputTokens);

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
        withdrawTo(payable(msg.sender));
    }

    /// @notice Withdraw everything owed to `msg.sender`, paying it to `recipient`.
    /// @dev Paying only `msg.sender` would strand the balance of any account that cannot
    ///      receive a plain native transfer. Buyers, providers and the treasury may all be
    ///      contracts here — a multisig, or anything whose fallback is not payable — and
    ///      for those the balance would be correctly recorded and permanently
    ///      unreachable. Naming a recipient costs nothing in trust: the balance still
    ///      belongs to `msg.sender` and only they can move it.
    function withdrawTo(address payable recipient) public {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: zero the balance before the external call.
        balances[msg.sender] = 0;

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, recipient, amount);
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

    /// @dev Every field `quote()` reads, plus `provider` and `settler`, so a buyer's
    ///      commitment also covers who gets paid and who can settle. `active` is left out
    ///      deliberately: `openCall` checks it directly, and folding it in would make a
    ///      buyer's funding transaction race a provider toggling availability.
    function _termsHash(bytes32 serviceId, Service memory s) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                serviceId,
                s.provider,
                s.settler,
                s.baseFeeWei,
                s.perInputTokenWei,
                s.perOutputTokenWei,
                s.maxOutputTokens
            )
        );
    }

    function _ownedService(bytes32 serviceId) private view returns (Service storage s) {
        s = services[serviceId];
        if (s.provider == address(0)) revert NoSuchService();
        if (s.provider != msg.sender) revert NotProvider();
    }
}
