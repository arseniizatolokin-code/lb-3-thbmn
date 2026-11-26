// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IReputation} from "./interfaces/IExternal.sol";

/// @title ReputationSBT
/// @notice Непередавана репутація (ERC-721 + ERC-5192): один токен на адресу, передачі заборонені.
contract ReputationSBT is ERC721, AccessControl, IReputation {
    bytes32 public constant ESCROW_ROLE = keccak256("ESCROW_ROLE");

    struct Stats {
        uint32 deals;
        uint32 disputes;
        uint32 disputesLost;
    }

    uint256 private _nextId = 1;
    mapping(address => uint256) public tokenOf;
    mapping(address => Stats) private _stats;

    /// @dev ERC-5192.
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);
    event ReputationUpdated(address indexed account, uint32 deals, uint32 disputes, uint32 disputesLost);

    error SoulboundTransfer();

    /// @param admin Адміністратор (видає ESCROW_ROLE).
    constructor(address admin) ERC721("Freelance Reputation", "FREP") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Випускає токен репутації, якщо його ще немає. Лише ESCROW_ROLE.
    /// @param account Власник токена.
    function mintIfAbsent(address account) public onlyRole(ESCROW_ROLE) {
        if (tokenOf[account] != 0) return;
        uint256 id = _nextId++;
        tokenOf[account] = id;
        _safeMint(account, id);
        emit Locked(id);
    }

    /// @notice Фіксує результат завершеної угоди. Лише ESCROW_ROLE.
    /// @param account Учасник угоди.
    /// @param disputed Чи був спір.
    /// @param lost Чи програв учасник спір.
    function recordOutcome(address account, bool disputed, bool lost) external override onlyRole(ESCROW_ROLE) {
        mintIfAbsent(account);
        Stats storage s = _stats[account];
        s.deals += 1;
        if (disputed) s.disputes += 1;
        if (lost) s.disputesLost += 1;
        emit ReputationUpdated(account, s.deals, s.disputes, s.disputesLost);
    }

    /// @notice ERC-5192: чи заблоковано токен (завжди true для існуючого).
    /// @param tokenId Номер токена.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @notice Статистика учасника.
    /// @param account Адреса учасника.
    function stats(address account) external view returns (uint32 deals, uint32 disputes, uint32 disputesLost) {
        Stats memory s = _stats[account];
        return (s.deals, s.disputes, s.disputesLost);
    }

    /// @inheritdoc ERC721
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId);
    }

    /// @dev Передачі заборонені: дозволено лише випуск (власник = нульова адреса).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert SoulboundTransfer();
        return super._update(to, tokenId, auth);
    }
}
