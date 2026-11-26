// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Частина RiskOracle, потрібна Escrow.
interface IRiskOracleView {
    struct RiskReport {
        uint16 riskBps;
        uint64 submittedAt;
        bytes32 modelVersion;
        bytes32 inputHash;
    }

    function getRisk(uint256 dealId) external view returns (RiskReport memory);

    function depositBps(uint16 riskBps) external pure returns (uint16);
}

/// @notice Частина ReputationSBT, потрібна Escrow.
interface IReputation {
    function recordOutcome(address account, bool disputed, bool lost) external;
}
