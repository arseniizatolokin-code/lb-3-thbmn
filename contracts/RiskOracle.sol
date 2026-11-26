// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IRiskOracleView} from "./interfaces/IExternal.sol";

/// @title RiskOracle
/// @notice Зберігає оцінки ризику спору, які надсилає офчейн ML-сервіс (оракул).
/// @dev Для кожної угоди зберігаємо: ризик, версію моделі, хеш вхідних даних і час.
contract RiskOracle is AccessControl, Pausable, IRiskOracleView {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    uint16 public constant MAX_RISK_BPS = 10_000;

    /// @notice Поточна адреса оракула (власник ORACLE_ROLE).
    address public oracle;
    mapping(uint256 => RiskReport) private _reports;
    /// @notice Зареєстровані версії моделі: хеш артефакту → час реєстрації (0 = не зареєстровано).
    mapping(bytes32 => uint64) public modelRegisteredAt;

    event RiskSubmitted(uint256 indexed dealId, uint16 riskBps, bytes32 modelVersion, bytes32 inputHash);
    event OracleReplaced(address indexed oldOracle, address indexed newOracle);
    event ModelRegistered(bytes32 indexed modelVersion, string uri);

    error RiskOutOfRange(uint16 riskBps);
    error ReportAlreadyExists(uint256 dealId);
    error ZeroAddress();
    error UnknownModel(bytes32 modelVersion);
    error ModelAlreadyRegistered(bytes32 modelVersion);

    /// @param admin Адміністратор (заміна оракула, пауза).
    /// @param firstOracle Початкова адреса оракула.
    constructor(address admin, address firstOracle) {
        if (admin == address(0) || firstOracle == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, firstOracle);
        oracle = firstOracle;
    }

    /// @notice Реєструє версію моделі (SHA-256 файлу моделі). Лише адміністратор.
    /// @param modelVersion Хеш файлу моделі.
    /// @param uri Де лежить картка моделі (наприклад, шлях у репозиторії).
    function registerModel(bytes32 modelVersion, string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (modelRegisteredAt[modelVersion] != 0) revert ModelAlreadyRegistered(modelVersion);
        modelRegisteredAt[modelVersion] = uint64(block.timestamp);
        emit ModelRegistered(modelVersion, uri);
    }

    /// @notice Записує оцінку ризику угоди. Лише ORACLE_ROLE; один раз для угоди; версія моделі має бути зареєстрована.
    /// @param dealId Номер угоди в Escrow.
    /// @param riskBps Ймовірність спору в базисних пунктах (0..10000).
    /// @param modelVersion Хеш артефакту моделі (SHA-256 у вигляді bytes32).
    /// @param inputHash Хеш вектора ознак, за яким модель порахувала ризик.
    function submitRisk(uint256 dealId, uint16 riskBps, bytes32 modelVersion, bytes32 inputHash)
        external
        onlyRole(ORACLE_ROLE)
        whenNotPaused
    {
        if (riskBps > MAX_RISK_BPS) revert RiskOutOfRange(riskBps);
        if (modelRegisteredAt[modelVersion] == 0) revert UnknownModel(modelVersion);
        if (_reports[dealId].submittedAt != 0) revert ReportAlreadyExists(dealId);
        _reports[dealId] = RiskReport(riskBps, uint64(block.timestamp), modelVersion, inputHash);
        emit RiskSubmitted(dealId, riskBps, modelVersion, inputHash);
    }

    /// @notice Замінює адресу оракула: стара втрачає роль, нова її отримує. Лише адміністратор.
    /// @param newOracle Нова адреса оракула.
    function replaceOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOracle == address(0)) revert ZeroAddress();
        address old = oracle;
        _revokeRole(ORACLE_ROLE, old);
        _grantRole(ORACLE_ROLE, newOracle);
        oracle = newOracle;
        emit OracleReplaced(old, newOracle);
    }

    /// @notice Аварійна зупинка прийому оцінок. Лише адміністратор.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Знімає паузу. Лише адміністратор.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Повертає звіт про ризик (submittedAt = 0, якщо оцінки ще немає).
    /// @param dealId Номер угоди.
    function getRisk(uint256 dealId) external view override returns (RiskReport memory) {
        return _reports[dealId];
    }

    /// @notice Політика депозиту: частка суми угоди у базисних пунктах, від 2 % до 20 %.
    /// @param riskBps Ризик у базисних пунктах.
    function depositBps(uint16 riskBps) public pure override returns (uint16) {
        uint256 d = 200 + (uint256(riskBps) * 18) / 100;
        return d > 2000 ? 2000 : uint16(d);
    }
}
