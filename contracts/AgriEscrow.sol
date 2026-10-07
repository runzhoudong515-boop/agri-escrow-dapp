// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  AgriEscrow
 * @notice Staged escrow payments for agricultural produce orders.
 *
 *  Flow:
 *    1. Buyer creates an order and locks ETH in the contract (status Funded).
 *    2. Seller ships before the shipping deadline and submits the hash of the
 *       shipping / quality-inspection document. An agreed upfront share
 *       (0-50%) is released to the seller immediately (status Shipped).
 *    3. Buyer confirms receipt -> remaining funds released to seller (Completed).
 *
 *  Protections:
 *    - Seller never ships before the deadline  -> buyer reclaims full refund.
 *    - Seller declines the order               -> buyer refunded in full.
 *    - Buyer goes silent after shipment        -> seller claims after confirmWindow.
 *    - Buyer disputes the delivery             -> arbiter splits the remaining funds.
 *
 *  All payouts use the pull-payment pattern: amounts are credited to
 *  `pendingWithdrawals` and each party calls `withdraw()` themselves.
 */
contract AgriEscrow {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Status {
        None,       // 0 - order does not exist
        Funded,     // 1 - buyer has locked funds, awaiting shipment
        Shipped,    // 2 - seller shipped, upfront share released
        Completed,  // 3 - buyer confirmed (or timeout), seller fully paid
        Refunded,   // 4 - seller rejected or missed deadline, buyer refunded
        Disputed,   // 5 - buyer raised a dispute, awaiting arbiter
        Resolved    // 6 - arbiter split the remaining funds
    }

    struct Order {
        // slot 0
        address buyer;
        uint96 amount;          // total escrowed (wei)
        // slot 1
        address seller;
        Status status;
        uint16 upfrontBps;      // share released on shipment, in basis points
        uint40 shipDeadline;    // unix time
        // slot 2
        uint40 createdAt;
        uint40 shippedAt;
        uint96 released;        // amount already credited to the seller
        // slot 3
        bytes32 docHash;        // keccak256 of the shipping / inspection document
        // slot 4+
        string product;         // short description, e.g. "Wheat 2t Grade A"
    }

    // ------------------------------------------------------------------
    // Constants & immutables
    // ------------------------------------------------------------------

    uint16 public constant MAX_UPFRONT_BPS = 5_000;     // at most 50% upfront
    uint16 private constant BPS_DENOMINATOR = 10_000;
    uint32 public constant MIN_SHIP_WINDOW = 1 minutes;
    uint32 public constant MAX_SHIP_WINDOW = 90 days;
    uint256 public constant MAX_PRODUCT_LENGTH = 64;
    uint256 public constant MAX_REASON_LENGTH = 200;

    /// @notice Neutral third party that resolves disputes.
    address public immutable arbiter;
    /// @notice Time the buyer has after shipment to confirm or dispute.
    uint256 public immutable confirmWindow;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    uint256 public orderCount;
    mapping(uint256 => Order) private _orders;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 private _locked = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint16 upfrontBps,
        uint40 shipDeadline,
        string product
    );
    event OrderShipped(uint256 indexed orderId, bytes32 docHash, uint256 upfrontReleased);
    event OrderCompleted(uint256 indexed orderId, uint256 sellerAmount, bool byTimeout);
    event OrderRefunded(uint256 indexed orderId, uint256 buyerAmount, bool rejectedBySeller);
    event DisputeRaised(uint256 indexed orderId, string reason);
    event DisputeResolved(uint256 indexed orderId, uint256 buyerAmount, uint256 sellerAmount);
    event Withdrawn(address indexed account, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error InvalidArbiter();
    error InvalidConfirmWindow();
    error InvalidSeller();
    error ArbiterCannotTrade();
    error InvalidAmount();
    error InvalidProduct();
    error UpfrontTooHigh();
    error InvalidShipWindow();
    error OrderNotFound();
    error NotBuyer();
    error NotSeller();
    error NotArbiter();
    error WrongStatus(Status current);
    error ShipDeadlinePassed();
    error ShipDeadlineNotReached();
    error ConfirmWindowClosed();
    error ConfirmWindowOpen();
    error EmptyDocHash();
    error InvalidReason();
    error InvalidSplit();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /// @param _arbiter       dispute resolver (e.g. the platform account)
    /// @param _confirmWindow seconds the buyer has to confirm after shipment
    constructor(address _arbiter, uint256 _confirmWindow) {
        if (_arbiter == address(0)) revert InvalidArbiter();
        if (_confirmWindow < 1 minutes || _confirmWindow > 30 days) revert InvalidConfirmWindow();
        arbiter = _arbiter;
        confirmWindow = _confirmWindow;
    }

    // ------------------------------------------------------------------
    // Buyer actions
    // ------------------------------------------------------------------

    /// @notice Create an order and lock `msg.value` in escrow.
    /// @param seller      farmer / supplier address
    /// @param product     short description (1-64 bytes)
    /// @param upfrontBps  share released on shipment (0-5000 = 0-50%)
    /// @param shipWindow  seconds the seller has to ship
    function createOrder(
        address seller,
        string calldata product,
        uint16 upfrontBps,
        uint32 shipWindow
    ) external payable returns (uint256 orderId) {
        if (seller == address(0) || seller == msg.sender) revert InvalidSeller();
        if (msg.sender == arbiter || seller == arbiter) revert ArbiterCannotTrade();
        if (msg.value == 0 || msg.value > type(uint96).max) revert InvalidAmount();
        uint256 len = bytes(product).length;
        if (len == 0 || len > MAX_PRODUCT_LENGTH) revert InvalidProduct();
        if (upfrontBps > MAX_UPFRONT_BPS) revert UpfrontTooHigh();
        if (shipWindow < MIN_SHIP_WINDOW || shipWindow > MAX_SHIP_WINDOW) revert InvalidShipWindow();

        orderId = ++orderCount;
        uint40 deadline = uint40(block.timestamp + shipWindow);

        Order storage o = _orders[orderId];
        o.buyer = msg.sender;
        o.amount = uint96(msg.value);
        o.seller = seller;
        o.status = Status.Funded;
        o.upfrontBps = upfrontBps;
        o.shipDeadline = deadline;
        o.createdAt = uint40(block.timestamp);
        o.product = product;

        emit OrderCreated(orderId, msg.sender, seller, msg.value, upfrontBps, deadline, product);
    }

    /// @notice Reclaim the full amount if the seller missed the shipping deadline.
    function claimRefund(uint256 orderId) external {
        Order storage o = _getOrder(orderId);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Funded) revert WrongStatus(o.status);
        if (block.timestamp <= o.shipDeadline) revert ShipDeadlineNotReached();

        o.status = Status.Refunded;
        pendingWithdrawals[o.buyer] += o.amount;
        emit OrderRefunded(orderId, o.amount, false);
    }

    /// @notice Confirm the goods arrived; releases the remaining funds to the seller.
    function confirmReceipt(uint256 orderId) external {
        Order storage o = _getOrder(orderId);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Shipped) revert WrongStatus(o.status);
        _complete(orderId, o, false);
    }

    /// @notice Dispute the delivery (quality, quantity...) within the confirm window.
    function raiseDispute(uint256 orderId, string calldata reason) external {
        Order storage o = _getOrder(orderId);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Shipped) revert WrongStatus(o.status);
        if (block.timestamp > uint256(o.shippedAt) + confirmWindow) revert ConfirmWindowClosed();
        uint256 len = bytes(reason).length;
        if (len == 0 || len > MAX_REASON_LENGTH) revert InvalidReason();

        o.status = Status.Disputed;
        emit DisputeRaised(orderId, reason);
    }

    // ------------------------------------------------------------------
    // Seller actions
    // ------------------------------------------------------------------

    /// @notice Decline an order before shipping; buyer is refunded in full.
    function rejectOrder(uint256 orderId) external {
        Order storage o = _getOrder(orderId);
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Funded) revert WrongStatus(o.status);

        o.status = Status.Refunded;
        pendingWithdrawals[o.buyer] += o.amount;
        emit OrderRefunded(orderId, o.amount, true);
    }

    /// @notice Mark the order as shipped and anchor the document hash on-chain.
    ///         Releases the agreed upfront share to the seller.
    function markShipped(uint256 orderId, bytes32 docHash) external {
        Order storage o = _getOrder(orderId);
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Funded) revert WrongStatus(o.status);
        if (block.timestamp > o.shipDeadline) revert ShipDeadlinePassed();
        if (docHash == bytes32(0)) revert EmptyDocHash();

        uint96 upfront = uint96((uint256(o.amount) * o.upfrontBps) / BPS_DENOMINATOR);

        o.status = Status.Shipped;
        o.shippedAt = uint40(block.timestamp);
        o.docHash = docHash;
        o.released = upfront;
        if (upfront > 0) pendingWithdrawals[o.seller] += upfront;

        emit OrderShipped(orderId, docHash, upfront);
    }

    /// @notice Collect the remaining funds if the buyer neither confirmed nor
    ///         disputed within the confirm window.
    function claimAfterTimeout(uint256 orderId) external {
        Order storage o = _getOrder(orderId);
        if (msg.sender != o.seller) revert NotSeller();
        if (o.status != Status.Shipped) revert WrongStatus(o.status);
        if (block.timestamp <= uint256(o.shippedAt) + confirmWindow) revert ConfirmWindowOpen();
        _complete(orderId, o, true);
    }

    // ------------------------------------------------------------------
    // Arbiter action
    // ------------------------------------------------------------------

    /// @notice Split the funds still in escrow between buyer and seller.
    /// @param buyerBps share of the remaining funds returned to the buyer (0-10000)
    function resolveDispute(uint256 orderId, uint16 buyerBps) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Order storage o = _getOrder(orderId);
        if (o.status != Status.Disputed) revert WrongStatus(o.status);
        if (buyerBps > BPS_DENOMINATOR) revert InvalidSplit();

        uint256 remaining = uint256(o.amount) - o.released;
        uint256 buyerShare = (remaining * buyerBps) / BPS_DENOMINATOR;
        uint256 sellerShare = remaining - buyerShare;

        o.status = Status.Resolved;
        o.released = o.amount;
        if (buyerShare > 0) pendingWithdrawals[o.buyer] += buyerShare;
        if (sellerShare > 0) pendingWithdrawals[o.seller] += sellerShare;

        emit DisputeResolved(orderId, buyerShare, sellerShare);
    }

    // ------------------------------------------------------------------
    // Withdrawal (pull payment)
    // ------------------------------------------------------------------

    /// @notice Withdraw everything credited to the caller.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Effects before interaction (checks-effects-interactions)
        pendingWithdrawals[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getOrder(uint256 orderId) external view returns (Order memory) {
        Order storage o = _orders[orderId];
        if (o.status == Status.None) revert OrderNotFound();
        return o;
    }

    /// @notice Unix time after which the seller may claim by timeout (0 if not shipped).
    function confirmDeadline(uint256 orderId) external view returns (uint256) {
        Order storage o = _orders[orderId];
        if (o.shippedAt == 0) return 0;
        return uint256(o.shippedAt) + confirmWindow;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _getOrder(uint256 orderId) private view returns (Order storage o) {
        o = _orders[orderId];
        if (o.status == Status.None) revert OrderNotFound();
    }

    function _complete(uint256 orderId, Order storage o, bool byTimeout) private {
        uint256 remainder = uint256(o.amount) - o.released;
        o.status = Status.Completed;
        o.released = o.amount;
        if (remainder > 0) pendingWithdrawals[o.seller] += remainder;
        emit OrderCompleted(orderId, remainder, byTimeout);
    }
}
