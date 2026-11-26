// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Тестовий контракт-учасник угоди: під час отримання коштів повторно викликає withdraw.
contract ReenterAttacker {
    address public immutable target;
    uint256 public attempts;

    constructor(address target_) {
        target = target_;
    }

    /// @dev Довільний виклик від імені контракту (щоб він міг бути замовником).
    function exec(address to, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        require(ok, "exec failed");
        return ret;
    }

    receive() external payable {
        attempts++;
        (bool ok, ) = target.call(abi.encodeWithSignature("withdraw()"));
        require(ok, "reenter failed");
    }
}
