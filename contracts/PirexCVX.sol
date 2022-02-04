// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20PresetMinterPauserUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/presets/ERC20PresetMinterPauserUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface ICvxLocker {
    function lock(
        address _account,
        uint256 _amount,
        uint256 _spendRatio
    ) external;
}

contract PirexCVX is Ownable {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    struct Deposit {
        uint256 amount;
        uint256 lockExpiry;
        address token;
    }

    address public cvxLocker;
    address public cvx;
    uint256 public epochDepositDuration;
    uint256 public lockDuration;
    address public immutable erc20Implementation;

    mapping(uint256 => Deposit) public deposits;

    event Deposited(
        uint256 amount,
        uint256 spendRatio,
        uint256 currentEpoch,
        uint256 totalAmount,
        uint256 lockExpiry,
        address token
    );

    constructor(
        address _cvxLocker,
        address _cvx,
        uint256 _epochDepositDuration,
        uint256 _lockDuration
    ) {
        require(_cvxLocker != address(0), "Invalid _cvxLocker");
        cvxLocker = _cvxLocker;

        require(_cvx != address(0), "Invalid _cvx");
        cvx = _cvx;

        require(_epochDepositDuration > 0, "Invalid _epochDepositDuration");
        epochDepositDuration = _epochDepositDuration;

        require(_lockDuration > 0, "Invalid _lockDuration");
        lockDuration = _lockDuration;

        erc20Implementation = address(new ERC20PresetMinterPauserUpgradeable());
    }

    /**
        @notice Deposit CVX into our protocol
        @param  amount      uint256  CVX amount
        @param  spendRatio  uint256  Used to calculate the spend amount and boost ratio
     */
    function deposit(uint256 amount, uint256 spendRatio) external {
        require(amount > 0, "Invalid amount");

        // Necessary as CvxLocker's lock method uses msg.sender when transferring
        IERC20(cvx).safeTransferFrom(msg.sender, address(this), amount);

        IERC20(cvx).safeIncreaseAllowance(cvxLocker, amount);
        ICvxLocker(cvxLocker).lock(address(this), amount, spendRatio);

        // Periods during which users can deposit CVX are every 2 weeks (i.e. epochs)
        uint256 currentEpoch = (block.timestamp / epochDepositDuration) *
            epochDepositDuration;
        Deposit storage d = deposits[currentEpoch];
        d.amount = d.amount + amount;

        // CVX can be withdrawn 17 weeks after the end of the epoch
        d.lockExpiry = currentEpoch + epochDepositDuration + lockDuration;

        mintVoteLockedCvx(msg.sender, amount, currentEpoch);

        emit Deposited(
            amount,
            spendRatio,
            currentEpoch,
            d.amount,
            d.lockExpiry,
            d.token
        );
    }

    /**
        @notice Mints vlCVX
        @param  recipient  uint256  Account receiving vlCVX
        @param  amount     uint256  Amount of vlCVX
        @param  epoch      uint256  Epoch to mint vlCVX for
     */
    function mintVoteLockedCvx(
        address recipient,
        uint256 amount,
        uint256 epoch
    ) internal {
        string memory name = string(
            abi.encodePacked("vlCVX-", epoch.toString())
        );
        Deposit storage d = deposits[epoch];

        if (d.token != address(0)) {
            ERC20PresetMinterPauserUpgradeable(d.token).mint(recipient, amount);
            return;
        }

        // Create a new vlCVX token for current epoch if it doesn't exist
        ERC20PresetMinterPauserUpgradeable _erc20 = ERC20PresetMinterPauserUpgradeable(
                Clones.clone(erc20Implementation)
            );

        _erc20.initialize(name, name);

        d.token = address(_erc20);

        _erc20.mint(recipient, amount);
    }
}
