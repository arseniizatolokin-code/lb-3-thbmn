// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRiskOracleView, IReputation} from "./interfaces/IExternal.sol";

/// @title Escrow
/// @notice Угода між замовником і виконавцем з етапами, ескроу та депозитами, розмір яких залежить від ризику спору.
/// @dev Головна сутність Deal — скінченний автомат: Proposed → Funded → InProgress → Completed,
///      із відгалуженнями Cancelled, Disputed → Resolved. Виплати лише за схемою pull (withdraw).
contract Escrow is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant MAX_MILESTONES = 10;
    uint64 public constant ACCEPT_WINDOW = 7 days;
    uint64 public constant AUTO_APPROVE_DELAY = 7 days;

    enum DealState { None, Proposed, Funded, InProgress, Disputed, Completed, Cancelled, Resolved }
    enum MilestoneState { Pending, Submitted, Approved, Rejected }

    struct Deal {
        address client;
        uint16 riskBps;
        uint8 milestoneCount;
        uint8 current;
        DealState state;
        uint64 createdAt;
        address freelancer;
        uint64 fundedAt;
        uint64 acceptedAt;
        uint128 total;
        uint128 paid;
        uint128 clientDeposit;
        uint128 freelancerDeposit;
        bytes32 specHash;
    }

    struct Milestone {
        uint128 amount;
        uint32 dueDays; // зсув від моменту прийняття угоди, у днях
        uint64 submittedAt;
        MilestoneState state;
    }

    IRiskOracleView public immutable riskOracle;
    IReputation public immutable reputation;

    uint256 public dealCount;
    mapping(uint256 => Deal) private _deals;
    mapping(uint256 => mapping(uint8 => Milestone)) private _milestones;
    mapping(address => uint256) public pendingWithdrawal;

    event DealProposed(uint256 indexed dealId, address indexed client, address indexed freelancer, uint256 total, bytes32 specHash, uint8 milestones);
    event DealFunded(uint256 indexed dealId, uint16 riskBps, uint256 clientDeposit, uint256 freelancerDeposit);
    event DealAccepted(uint256 indexed dealId, uint64 acceptedAt);
    event MilestoneSubmitted(uint256 indexed dealId, uint8 index, bytes32 resultHash);
    event MilestoneApproved(uint256 indexed dealId, uint8 index, uint256 amount, bool automatic);
    event MilestoneRejected(uint256 indexed dealId, uint8 index);
    event DealDisputed(uint256 indexed dealId, address indexed opener);
    event DisputeResolved(uint256 indexed dealId, uint8 clientSharePercent);
    event DealCancelled(uint256 indexed dealId, bool overdue);
    event DealCompleted(uint256 indexed dealId);
    event Withdrawn(address indexed account, uint256 amount);

    error NotClient(address caller);
    error NotFreelancer(address caller);
    error NotParty(address caller);
    error WrongState(DealState actual);
    error WrongMilestone(uint8 index);
    error WrongMilestoneState(MilestoneState actual);
    error RiskNotReady(uint256 dealId);
    error WrongAmount(uint256 required, uint256 sent);
    error AcceptWindowClosed();
    error NotYetAvailable(uint64 availableAt);
    error InvalidInput();
    error NothingToWithdraw();
    error TransferFailed();

    /// @param admin Адміністратор (пауза, видача ARBITER_ROLE).
    /// @param oracle_ Контракт RiskOracle.
    /// @param reputation_ Контракт ReputationSBT.
    constructor(address admin, address oracle_, address reputation_) {
        if (admin == address(0) || oracle_ == address(0) || reputation_ == address(0)) revert InvalidInput();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        riskOracle = IRiskOracleView(oracle_);
        reputation = IReputation(reputation_);
    }

    // ------------------------------------------------------------ керування

    /// @notice Аварійна зупинка: усі функції зміни стану відхиляються, крім withdraw.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Знімає паузу.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------ життєвий цикл

    /// @notice Замовник створює угоду. Кошти ще не вносяться: спершу оракул має подати оцінку ризику.
    /// @param freelancer Виконавець.
    /// @param amounts Суми етапів, wei.
    /// @param dueDays Строки етапів у днях від прийняття угоди (строго зростають).
    /// @param specHash Хеш технічного завдання (текст зберігається поза ланцюгом).
    /// @return dealId Номер угоди.
    function proposeDeal(address freelancer, uint128[] calldata amounts, uint32[] calldata dueDays, bytes32 specHash)
        external
        whenNotPaused
        returns (uint256 dealId)
    {
        uint256 n = amounts.length;
        if (freelancer == address(0) || freelancer == msg.sender) revert InvalidInput();
        if (n == 0 || n > MAX_MILESTONES || n != dueDays.length) revert InvalidInput();
        dealId = ++dealCount;
        uint128 total = 0;
        uint32 prev = 0;
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0 || dueDays[i] <= prev) revert InvalidInput();
            prev = dueDays[i];
            total += amounts[i];
            _milestones[dealId][uint8(i)] = Milestone(amounts[i], dueDays[i], 0, MilestoneState.Pending);
        }
        Deal storage d = _deals[dealId];
        d.client = msg.sender;
        d.freelancer = freelancer;
        d.milestoneCount = uint8(n);
        d.state = DealState.Proposed;
        d.createdAt = uint64(block.timestamp);
        d.total = total;
        d.specHash = specHash;
        emit DealProposed(dealId, msg.sender, freelancer, total, specHash, uint8(n));
    }

    /// @notice Замовник вносить суму угоди та свій страховий депозит. Потрібна оцінка ризику від оракула.
    /// @param dealId Номер угоди.
    function fundDeal(uint256 dealId) external payable whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.Proposed) revert WrongState(d.state);
        if (msg.sender != d.client) revert NotClient(msg.sender);
        IRiskOracleView.RiskReport memory r = riskOracle.getRisk(dealId);
        if (r.submittedAt == 0) revert RiskNotReady(dealId);
        uint128 dep = uint128((uint256(d.total) * riskOracle.depositBps(r.riskBps)) / 10_000);
        uint256 required = uint256(d.total) + dep;
        if (msg.value != required) revert WrongAmount(required, msg.value);
        d.riskBps = r.riskBps;
        d.clientDeposit = dep;
        d.freelancerDeposit = dep;
        d.fundedAt = uint64(block.timestamp);
        d.state = DealState.Funded;
        emit DealFunded(dealId, r.riskBps, dep, dep);
    }

    /// @notice Виконавець приймає угоду й вносить свій депозит протягом ACCEPT_WINDOW.
    /// @param dealId Номер угоди.
    function acceptDeal(uint256 dealId) external payable whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.Funded) revert WrongState(d.state);
        if (msg.sender != d.freelancer) revert NotFreelancer(msg.sender);
        if (block.timestamp > uint256(d.fundedAt) + ACCEPT_WINDOW) revert AcceptWindowClosed();
        if (msg.value != d.freelancerDeposit) revert WrongAmount(d.freelancerDeposit, msg.value);
        d.acceptedAt = uint64(block.timestamp);
        d.state = DealState.InProgress;
        emit DealAccepted(dealId, d.acceptedAt);
    }

    /// @notice Замовник скасовує угоду до початку роботи; внесені кошти повертаються на баланс.
    /// @param dealId Номер угоди.
    function cancelDeal(uint256 dealId) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (msg.sender != d.client) revert NotClient(msg.sender);
        DealState s = d.state;
        if (s != DealState.Proposed && s != DealState.Funded) revert WrongState(s);
        d.state = DealState.Cancelled;
        if (s == DealState.Funded) pendingWithdrawal[d.client] += uint256(d.total) + d.clientDeposit;
        emit DealCancelled(dealId, false);
    }

    /// @notice Виконавець здає поточний етап (або здає повторно після відхилення).
    /// @param dealId Номер угоди.
    /// @param index Номер етапу (має збігатися з поточним).
    /// @param resultHash Хеш результату (файл зберігається поза ланцюгом).
    function submitMilestone(uint256 dealId, uint8 index, bytes32 resultHash) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.InProgress) revert WrongState(d.state);
        if (msg.sender != d.freelancer) revert NotFreelancer(msg.sender);
        if (index != d.current) revert WrongMilestone(index);
        Milestone storage m = _milestones[dealId][index];
        if (m.state != MilestoneState.Pending && m.state != MilestoneState.Rejected) revert WrongMilestoneState(m.state);
        m.state = MilestoneState.Submitted;
        m.submittedAt = uint64(block.timestamp);
        emit MilestoneSubmitted(dealId, index, resultHash);
    }

    /// @notice Замовник схвалює етап: сума потрапляє на баланс виконавця.
    /// @param dealId Номер угоди.
    /// @param index Номер етапу.
    function approveMilestone(uint256 dealId, uint8 index) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (msg.sender != d.client) revert NotClient(msg.sender);
        _release(dealId, d, index, false);
    }

    /// @notice Виконавець забирає оплату, якщо замовник не відреагував на здачу етапу за AUTO_APPROVE_DELAY.
    /// @param dealId Номер угоди.
    /// @param index Номер етапу.
    function autoApprove(uint256 dealId, uint8 index) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (msg.sender != d.freelancer) revert NotFreelancer(msg.sender);
        uint64 at = _milestones[dealId][index].submittedAt + AUTO_APPROVE_DELAY;
        if (block.timestamp < at) revert NotYetAvailable(at);
        _release(dealId, d, index, true);
    }

    /// @notice Замовник відхиляє здачу етапу.
    /// @param dealId Номер угоди.
    /// @param index Номер етапу.
    function rejectMilestone(uint256 dealId, uint8 index) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.InProgress) revert WrongState(d.state);
        if (msg.sender != d.client) revert NotClient(msg.sender);
        if (index != d.current) revert WrongMilestone(index);
        Milestone storage m = _milestones[dealId][index];
        if (m.state != MilestoneState.Submitted) revert WrongMilestoneState(m.state);
        m.state = MilestoneState.Rejected;
        emit MilestoneRejected(dealId, index);
    }

    /// @notice Замовник скасовує угоду, якщо виконавець прострочив етап. Кошти й обидва депозити йдуть замовнику.
    /// @param dealId Номер угоди.
    function cancelOverdue(uint256 dealId) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.InProgress) revert WrongState(d.state);
        if (msg.sender != d.client) revert NotClient(msg.sender);
        Milestone storage m = _milestones[dealId][d.current];
        if (m.state != MilestoneState.Pending) revert WrongMilestoneState(m.state);
        uint64 dueAt = d.acceptedAt + uint64(m.dueDays) * 1 days;
        if (block.timestamp <= dueAt) revert NotYetAvailable(dueAt);
        d.state = DealState.Cancelled;
        pendingWithdrawal[d.client] += uint256(d.total) - d.paid + d.clientDeposit + d.freelancerDeposit;
        emit DealCancelled(dealId, true);
    }

    /// @notice Сторона відкриває спір щодо поточного етапу (здано або відхилено).
    /// @param dealId Номер угоди.
    function openDispute(uint256 dealId) external whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.InProgress) revert WrongState(d.state);
        if (msg.sender != d.client && msg.sender != d.freelancer) revert NotParty(msg.sender);
        MilestoneState ms = _milestones[dealId][d.current].state;
        if (ms != MilestoneState.Submitted && ms != MilestoneState.Rejected) revert WrongMilestoneState(ms);
        d.state = DealState.Disputed;
        emit DealDisputed(dealId, msg.sender);
    }

    /// @notice Арбітр розподіляє кошти, що лишилися. Програвший спір втрачає депозит на користь супротивника.
    /// @param dealId Номер угоди.
    /// @param clientSharePercent Частка замовника від залишку, 0..100. Понад 50 — виграв замовник, менше 50 — виконавець.
    function resolveDispute(uint256 dealId, uint8 clientSharePercent) external onlyRole(ARBITER_ROLE) whenNotPaused {
        Deal storage d = _deals[dealId];
        if (d.state != DealState.Disputed) revert WrongState(d.state);
        if (clientSharePercent > 100) revert InvalidInput();
        d.state = DealState.Resolved;
        uint256 remaining = uint256(d.total) - d.paid;
        uint256 clientPart = (remaining * clientSharePercent) / 100;
        uint256 freelancerPart = remaining - clientPart;
        uint256 cd = d.clientDeposit;
        uint256 fd = d.freelancerDeposit;
        bool clientLost = clientSharePercent < 50;
        bool freelancerLost = clientSharePercent > 50;
        if (clientLost) freelancerPart += cd; else clientPart += cd;
        if (freelancerLost) clientPart += fd; else freelancerPart += fd;
        pendingWithdrawal[d.client] += clientPart;
        pendingWithdrawal[d.freelancer] += freelancerPart;
        emit DisputeResolved(dealId, clientSharePercent);
        reputation.recordOutcome(d.client, true, clientLost);
        reputation.recordOutcome(d.freelancer, true, freelancerLost);
    }

    /// @notice Забирає накопичений баланс (схема pull). Працює і під паузою.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawal[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawal[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------ читання

    /// @notice Дані угоди.
    /// @param dealId Номер угоди.
    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _deals[dealId];
    }

    /// @notice Дані етапу.
    /// @param dealId Номер угоди.
    /// @param index Номер етапу.
    function getMilestone(uint256 dealId, uint8 index) external view returns (Milestone memory) {
        return _milestones[dealId][index];
    }

    // ------------------------------------------------------------ внутрішнє

    function _release(uint256 dealId, Deal storage d, uint8 index, bool automatic) private {
        if (d.state != DealState.InProgress) revert WrongState(d.state);
        if (index != d.current) revert WrongMilestone(index);
        Milestone storage m = _milestones[dealId][index];
        if (m.state != MilestoneState.Submitted) revert WrongMilestoneState(m.state);
        m.state = MilestoneState.Approved;
        uint128 amount = m.amount;
        d.paid += amount;
        pendingWithdrawal[d.freelancer] += amount;
        uint8 next = index + 1;
        d.current = next;
        emit MilestoneApproved(dealId, index, amount, automatic);
        if (next == d.milestoneCount) {
            d.state = DealState.Completed;
            pendingWithdrawal[d.client] += d.clientDeposit;
            pendingWithdrawal[d.freelancer] += d.freelancerDeposit;
            emit DealCompleted(dealId);
            reputation.recordOutcome(d.client, false, false);
            reputation.recordOutcome(d.freelancer, false, false);
        }
    }
}
