// SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ERC20Snapshot} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Snapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC1155PresetMinterSupply} from "./ERC1155PresetMinterSupply.sol";
import {IVotiumMultiMerkleStash} from "./interfaces/IVotiumMultiMerkleStash.sol";
import {PirexCvxConvex} from "./PirexCvxConvex.sol";
import {PirexFees} from "./PirexFees.sol";
import {UnionPirexVault} from "./UnionPirexVault.sol";

contract PirexCvx is ReentrancyGuard, ERC20Snapshot, PirexCvxConvex {
    using SafeERC20 for ERC20;

    /**
        @notice Epoch details
        @notice Reward/snapshotRewards/futuresRewards indexes are associated with 1 reward
        @param  snapshotId               uint96     Snapshot id
        @param  rewards                  address[]  Rewards
        @param  snapshotRewards          uint256[]  Snapshot reward amounts
        @param  futuresRewards           uint256[]  Futures reward amounts
        @param  redeemedSnapshotRewards  mapping    Redeemed snapshot rewards
     */
    struct Epoch {
        uint96 snapshotId;
        address[] rewards;
        uint256[] snapshotRewards;
        uint256[] futuresRewards;
        mapping(address => mapping(uint8 => uint256)) redeemedSnapshotRewards;
    }

    /**
        @notice Queued fee changes
        @param  newFee          uint32   New fee
        @param  effectiveAfter  uint256  Timestamp after which new fee could take affect
     */
    struct QueuedFee {
        uint32 newFee;
        uint224 effectiveAfter;
    }

    // Users can choose between the two futures tokens when staking or unlocking
    enum Futures {
        Vote,
        Reward
    }

    // Configurable contracts
    enum Contract {
        PirexFees,
        UpCvx,
        VpCvx,
        RpCvx,
        SpCvx,
        UnionPirexVault
    }

    // Configurable fees
    enum Fees {
        Reward,
        RedemptionMax,
        RedemptionMin
    }

    // Seconds between Convex voting rounds (2 weeks)
    uint32 public constant EPOCH_DURATION = 1209600;

    // Fee denominator
    uint32 public constant FEE_DENOMINATOR = 1000000;

    // Maximum wait time (seconds) for a CVX redemption (17 weeks)
    uint32 public constant MAX_REDEMPTION_TIME = 10281600;

    PirexFees public pirexFees;
    IVotiumMultiMerkleStash public votiumMultiMerkleStash;
    ERC1155PresetMinterSupply public upCvx;
    ERC1155PresetMinterSupply public vpCvx;
    ERC1155PresetMinterSupply public rpCvx;
    ERC1155PresetMinterSupply public spCvx;
    UnionPirexVault public unionPirex;

    // Epochs mapped to epoch details
    mapping(uint256 => Epoch) private epochs;

    // Fees (e.g. 5000 / 1000000 = 0.5%)
    mapping(Fees => uint32) public fees;

    // Convex unlock timestamps mapped to amount being redeemed
    mapping(uint256 => uint256) public redemptions;

    // Queued fees which will take effective after 1 epoch (2 weeks)
    mapping(Fees => QueuedFee) public queuedFees;

    event SetContract(Contract indexed c, address contractAddress);
    event QueueFee(Fees indexed f, uint32 newFee, uint224 effectiveAfter);
    event SetFee(Fees indexed f, uint32 fee);
    event MintFutures(
        uint8 rounds,
        address indexed to,
        uint256 amount,
        Futures indexed f
    );
    event Deposit(
        address indexed to,
        uint256 shares,
        bool indexed shouldCompound
    );
    event InitiateRedemption(
        address indexed sender,
        address indexed to,
        uint256 amount,
        uint256 unlockTime,
        uint256 postFeeAmount,
        uint256 feeAmount
    );
    event Redeem(uint256 indexed epoch, address indexed to, uint256 amount);
    event Stake(
        uint8 rounds,
        Futures indexed f,
        address indexed to,
        uint256 amount
    );
    event Unstake(uint256 id, address indexed to, uint256 amount);
    event ClaimMiscRewards(uint256 timestamp, ConvexReward[] rewards);
    event ClaimVotiumReward(
        address indexed token,
        uint256 index,
        uint256 amount
    );
    event RedeemSnapshotReward(
        uint256 indexed epoch,
        uint256 rewardIndex,
        address to,
        uint96 indexed snapshotId,
        uint256 snapshotBalance,
        uint256 redeemAmount
    );
    event RedeemFuturesRewards(
        uint256 indexed epoch,
        address indexed to,
        address[] rewards
    );
    event ExchangeFutures(
        uint256 indexed epoch,
        address indexed to,
        uint256 amount,
        Futures i,
        Futures o
    );

    error ZeroAmount();
    error BeforeUnlock();
    error InsufficientBalance();
    error AlreadyClaimed();
    error AlreadyRedeemed();
    error SnapshotRequired();
    error InsufficientRedemptionAllowance();
    error PastExchangePeriod();
    error InvalidNewFee();
    error BeforeEffectiveTimestamp();
    error BeforeStakingExpiry();

    /**
        @param  _CVX                     address  CVX address    
        @param  _cvxLocker               address  CvxLocker address
        @param  _cvxDelegateRegistry     address  CvxDelegateRegistry address
        @param  _cvxRewardPool           address  CvxRewardPool address
        @param  _cvxCRV                  address  CvxCrvToken address
        @param  _pirexFees               address  PirexFees address
        @param  _votiumMultiMerkleStash  address  VotiumMultiMerkleStash address
     */
    constructor(
        address _CVX,
        address _cvxLocker,
        address _cvxDelegateRegistry,
        address _cvxRewardPool,
        address _cvxCRV,
        address _pirexFees,
        address _votiumMultiMerkleStash
    )
        ERC20("Pirex CVX", "pCVX")
        PirexCvxConvex(
            _CVX,
            _cvxLocker,
            _cvxDelegateRegistry,
            _cvxRewardPool,
            _cvxCRV
        )
    {
        // Set up 1st epoch with snapshot id 1 and prevent reward claims until subsequent epochs
        epochs[getCurrentEpoch()].snapshotId = uint96(_snapshot());

        if (_pirexFees == address(0)) revert ZeroAddress();
        pirexFees = PirexFees(_pirexFees);

        if (_votiumMultiMerkleStash == address(0)) revert ZeroAddress();
        votiumMultiMerkleStash = IVotiumMultiMerkleStash(
            _votiumMultiMerkleStash
        );

        upCvx = new ERC1155PresetMinterSupply("");
        vpCvx = new ERC1155PresetMinterSupply("");
        rpCvx = new ERC1155PresetMinterSupply("");
        spCvx = new ERC1155PresetMinterSupply("");
    }

    /** 
        @notice Set a contract address
        @param  c                enum     Contract
        @param  contractAddress  address  Contract address    
     */
    function setContract(Contract c, address contractAddress)
        external
        onlyOwner
    {
        if (contractAddress == address(0)) revert ZeroAddress();

        emit SetContract(c, contractAddress);

        if (c == Contract.PirexFees) {
            pirexFees = PirexFees(contractAddress);
            return;
        }

        if (c == Contract.UpCvx) {
            upCvx = ERC1155PresetMinterSupply(contractAddress);
            return;
        }

        if (c == Contract.VpCvx) {
            vpCvx = ERC1155PresetMinterSupply(contractAddress);
            return;
        }

        if (c == Contract.RpCvx) {
            rpCvx = ERC1155PresetMinterSupply(contractAddress);
            return;
        }

        if (c == Contract.SpCvx) {
            spCvx = ERC1155PresetMinterSupply(contractAddress);
            return;
        }

        unionPirex = UnionPirexVault(contractAddress);
    }

    /** 
        @notice Queue fee
        @param  f       enum    Fee enum
        @param  newFee  uint32  New fee
     */
    function queueFee(Fees f, uint32 newFee) external onlyOwner {
        if (newFee > FEE_DENOMINATOR) revert InvalidNewFee();

        uint224 effectiveAfter = uint224(block.timestamp + EPOCH_DURATION);

        // Queue up the fee change, which can be set after 2 weeks
        queuedFees[f].newFee = newFee;
        queuedFees[f].effectiveAfter = effectiveAfter;

        emit QueueFee(f, newFee, effectiveAfter);
    }

    /** 
        @notice Set fee
        @param  f  Fees  Fee enum
     */
    function setFee(Fees f) external onlyOwner {
        QueuedFee memory q = queuedFees[f];

        if (q.effectiveAfter > block.timestamp)
            revert BeforeEffectiveTimestamp();

        fees[f] = q.newFee;

        emit SetFee(f, q.newFee);
    }

    /**
        @notice Get current epoch
        @return uint256  Current epoch
     */
    function getCurrentEpoch() public view returns (uint256) {
        return (block.timestamp / EPOCH_DURATION) * EPOCH_DURATION;
    }

    /**
        @notice Get current snapshot id
        @return uint256  Current snapshot id
     */
    function getCurrentSnapshotId() external view returns (uint256) {
        return _getCurrentSnapshotId();
    }

    /**
        @notice Get epoch
        @param  epoch            uint256    Epoch
        @return snapshotId       uint96     Snapshot id
        @return rewards          address[]  Reward tokens
        @return snapshotRewards  uint256[]  Snapshot reward amounts
        @return futuresRewards   uint256[]  Futures reward amounts
     */
    function getEpoch(uint256 epoch)
        external
        view
        returns (
            uint96 snapshotId,
            address[] memory rewards,
            uint256[] memory snapshotRewards,
            uint256[] memory futuresRewards
        )
    {
        Epoch storage e = epochs[epoch];

        return (e.snapshotId, e.rewards, e.snapshotRewards, e.futuresRewards);
    }

    /**
        @notice Mint futures tokens
        @param  rounds  uint8    Rounds (i.e. Convex voting rounds)
        @param  to      address  Futures recipient
        @param  amount  uint256  Futures amount
        @param  f       enum     Futures
    */
    function _mintFutures(
        uint8 rounds,
        address to,
        uint256 amount,
        Futures f
    ) internal {
        emit MintFutures(rounds, to, amount, f);

        uint256 startingEpoch = getCurrentEpoch() + EPOCH_DURATION;
        ERC1155PresetMinterSupply token = f == Futures.Vote ? vpCvx : rpCvx;

        for (uint8 i; i < rounds; ++i) {
            // Validates `to`
            token.mint(to, startingEpoch + i * EPOCH_DURATION, amount, "");
        }
    }

    /**
        @notice Calculate rewards
        @param  feePercent      uint32   Reward fee percent
        @param  snapshotSupply  uint256  pCVX supply for the current snapshot id
        @param  rpCvxSupply     uint256  rpCVX supply for the current epoch
        @param  received        uint256  Received amount
    */
    function _calculateRewards(
        uint32 feePercent,
        uint256 snapshotSupply,
        uint256 rpCvxSupply,
        uint256 received
    )
        internal
        pure
        returns (
            uint256 rewardFee,
            uint256 snapshotRewards,
            uint256 futuresRewards
        )
    {
        // Rewards paid to the protocol
        rewardFee = (received * feePercent) / FEE_DENOMINATOR;

        // Rewards distributed amongst snapshot and futures tokenholders
        uint256 rewards = received - rewardFee;

        // Rewards distributed to snapshotted tokenholders
        snapshotRewards =
            (rewards * snapshotSupply) /
            (snapshotSupply + rpCvxSupply);

        // Rewards distributed to rpCVX token holders
        futuresRewards = rewards - snapshotRewards;
    }

    /**
        @notice Snapshot token balances for the current epoch
     */
    function takeEpochSnapshot() public whenNotPaused {
        uint256 currentEpoch = getCurrentEpoch();

        // If snapshot has not been set for current epoch, take snapshot
        if (epochs[currentEpoch].snapshotId == 0) {
            epochs[currentEpoch].snapshotId = uint96(_snapshot());
        }
    }

    /**
        @notice Deposit CVX
        @param  to              address  Address receiving pCVX
        @param  amount          uint256  CVX amount
        @param  shouldCompound  bool     Deposit into auto-compounding vault
     */
    function deposit(
        address to,
        uint256 amount,
        bool shouldCompound
    ) external whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Perform epoch maintenance if necessary
        takeEpochSnapshot();

        // Mint pCVX - recipient depends on whether or not to compound
        _mint(shouldCompound ? address(this) : to, amount);

        emit Deposit(to, amount, shouldCompound);

        if (shouldCompound) {
            _approve(address(this), address(unionPirex), amount);

            // Deposit pCVX into pounder vault - user receives shares
            unionPirex.deposit(amount, to);
        }

        // Transfer CVX to self and approve for locking
        CVX.safeTransferFrom(msg.sender, address(this), amount);

        // Lock CVX
        _lock(amount);
    }

    /**
        @notice Initiate CVX redemption
        @param  lockIndex  uint8    Locked balance index
        @param  f          enum     Futures
        @param  to         address  upCVX recipient
        @param  amount     uint256  pCVX/upCVX amount
     */
    function initiateRedemption(
        uint8 lockIndex,
        Futures f,
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Validates `lockIndex` is within bounds of the array - reverts otherwise
        (uint256 lockAmount, uint256 unlockTime) = _getLockData(lockIndex);

        // Calculate the fee based on the duration a user has to wait before redeeming CVX
        uint256 waitTime = unlockTime - block.timestamp;
        uint32 feeMax = fees[Fees.RedemptionMax];
        uint32 feePercent = uint32(
            feeMax -
                (((feeMax - fees[Fees.RedemptionMin]) * waitTime) /
                    MAX_REDEMPTION_TIME)
        );
        uint256 feeAmount = (amount * feePercent) / FEE_DENOMINATOR;
        uint256 postFeeAmount = amount - feeAmount;

        // Increment redemptions for this unlockTime to prevent over-redeeming
        redemptions[unlockTime] += postFeeAmount;

        // Check if there is any sufficient allowance after factoring in redemptions by others
        if (redemptions[unlockTime] > lockAmount)
            revert InsufficientRedemptionAllowance();

        // Burn pCVX - reverts if sender balance is insufficient
        _burn(msg.sender, postFeeAmount);

        // Allow PirexFees to distribute fees directly from sender
        _approve(msg.sender, address(pirexFees), feeAmount);

        // Track amount that needs to remain unlocked for redemptions
        outstandingRedemptions += postFeeAmount;

        emit InitiateRedemption(
            msg.sender,
            to,
            amount,
            unlockTime,
            postFeeAmount,
            feeAmount
        );

        // Distribute fees
        pirexFees.distributeFees(msg.sender, address(this), feeAmount);

        // Mint upCVX with unlockTime as the id - validates `to`
        upCvx.mint(to, unlockTime, postFeeAmount, "");

        // Determine how many futures notes rounds to mint
        uint8 rounds = uint8(waitTime / EPOCH_DURATION);

        // Check if the lock was in the first week/half of an epoch
        // Handle case where remaining time is between 1 and 2 weeks
        if (
            rounds == 0 &&
            unlockTime % EPOCH_DURATION != 0 &&
            waitTime < EPOCH_DURATION &&
            waitTime > (EPOCH_DURATION / 2)
        ) {
            // Rounds is 0 if waitTime is between 1 and 2 weeks
            // Increment by 1 since user should receive 1 round of rewards
            unchecked {
                ++rounds;
            }
        }

        // Mint vpCVX or rpCVX (using amount as we do not take a fee from this)
        _mintFutures(rounds, to, amount, f);
    }

    /**
        @notice Redeem CVX
        @param  unlockTime  uint256  CVX unlock timestamp
        @param  to          address  CVX recipient
        @param  amount      uint256  upCVX/CVX amount
     */
    function redeem(
        uint256 unlockTime,
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        // Revert if CVX has not been unlocked and cannot be redeemed yet
        if (unlockTime > block.timestamp) revert BeforeUnlock();
        if (amount == 0) revert ZeroAmount();

        emit Redeem(unlockTime, to, amount);

        // Unlock and relock if balance is greater than outstandingRedemptions
        _relock();

        // Subtract redemption amount from outstanding CVX amount
        outstandingRedemptions -= amount;

        // Reverts if sender has an insufficient amount of upCVX with unlockTime id
        upCvx.burn(msg.sender, unlockTime, amount);

        // Validates `to`
        CVX.safeTransfer(to, amount);
    }

    /**
        @notice Stake pCVX
        @param  rounds  uint8    Rounds (i.e. Convex voting rounds)
        @param  f       enum     Futures
        @param  to      address  spCVX recipient
        @param  amount  uint256  pCVX/spCVX amount
    */
    function stake(
        uint8 rounds,
        Futures f,
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (rounds == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Burn pCVX
        _burn(msg.sender, amount);

        emit Stake(rounds, f, to, amount);

        // Mint spCVX with the stake expiry timestamp as the id
        spCvx.mint(to, getCurrentEpoch() + EPOCH_DURATION * rounds, amount, "");

        _mintFutures(rounds, to, amount, f);
    }

    /**
        @notice Unstake pCVX
        @param  id      uint256  spCVX id
        @param  to      address  pCVX recipient
        @param  amount  uint256  pCVX/spCVX amount
    */
    function unstake(
        uint256 id,
        address to,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (id > block.timestamp) revert BeforeStakingExpiry();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Mint pCVX
        _mint(to, amount);

        emit Unstake(id, to, amount);

        // Burn spCVX
        spCvx.burn(msg.sender, id, amount);
    }

    /**
        @notice Claim Votium reward
        @param  token        address    Reward token address
        @param  index        uint256    Merkle tree node index
        @param  amount       uint256    Reward token amount
        @param  merkleProof  bytes32[]  Merkle proof
    */
    function claimVotiumReward(
        address token,
        uint256 index,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external whenNotPaused nonReentrant {
        // Check if maintenance has been performed on the epoch
        uint256 currentEpoch = getCurrentEpoch();
        if (epochs[currentEpoch].snapshotId == 0) revert SnapshotRequired();

        emit ClaimVotiumReward(token, index, amount);

        ERC20 t = ERC20(token);

        // Used for calculating the actual token amount received
        uint256 prevBalance = t.balanceOf(address(this));

        // Validates `token`, `index`, `amount`, and `merkleProof`
        votiumMultiMerkleStash.claim(
            token,
            index,
            address(this),
            amount,
            merkleProof
        );

        (
            uint256 rewardFee,
            uint256 snapshotRewards,
            uint256 futuresRewards
        ) = _calculateRewards(
                fees[Fees.Reward],
                totalSupplyAt(_getCurrentSnapshotId()),
                rpCvx.totalSupply(currentEpoch),
                t.balanceOf(address(this)) - prevBalance
            );

        // Add reward token address and snapshot/futuresRewards amounts (same index for all)
        Epoch storage e = epochs[currentEpoch];
        e.rewards.push(token);
        e.snapshotRewards.push(snapshotRewards);
        e.futuresRewards.push(futuresRewards);

        // Distribute fees
        t.safeIncreaseAllowance(address(pirexFees), rewardFee);
        pirexFees.distributeFees(address(this), token, rewardFee);
    }

    /**
        @notice Claim misc. rewards (e.g. emissions) and distribute to stakeholders
     */
    function claimMiscRewards() external whenNotPaused nonReentrant {
        // Get claimable rewards and balances
        ConvexReward[] memory c = _claimableRewards();

        emit ClaimMiscRewards(block.timestamp, c);

        // Claim rewards from Convex
        _getReward();

        uint8 cLen = uint8(c.length);

        // Iterate over rewards and distribute to stakeholders (rlBTRFLY, Redacted, and Pirex)
        for (uint8 i; i < cLen; ++i) {
            if (c[i].amount == 0) continue;

            ERC20 t = ERC20(c[i].token);
            uint256 received = t.balanceOf(address(this)) - c[i].balance;

            // Distribute fees
            t.safeIncreaseAllowance(address(pirexFees), received);
            pirexFees.distributeFees(address(this), c[i].token, received);
        }
    }

    /**
        @notice Redeem a Snapshot reward as a pCVX holder
        @param  epoch        uint256  Epoch
        @param  rewardIndex  uint8    Reward token index
        @param  to           address  Snapshot reward recipient
    */
    function redeemSnapshotReward(
        uint256 epoch,
        uint8 rewardIndex,
        address to
    ) external whenNotPaused nonReentrant {
        if (epoch == 0) revert ZeroAmount();

        Epoch storage e = epochs[epoch];

        // Check whether msg.sender maintained a positive balance before the snapshot
        uint96 snapshotId = e.snapshotId;
        uint256 snapshotBalance = balanceOfAt(msg.sender, snapshotId);
        if (snapshotBalance == 0) revert InsufficientBalance();

        // Check whether msg.sender has already redeemed this reward
        if (e.redeemedSnapshotRewards[msg.sender][rewardIndex] != 0)
            revert AlreadyRedeemed();

        // Proportionate to the % of pCVX owned out of total supply for the snapshot
        uint256 redeemAmount = (e.snapshotRewards[rewardIndex] *
            snapshotBalance) / totalSupplyAt(snapshotId);

        // Set redeem amount to prevent double redemptions
        e.redeemedSnapshotRewards[msg.sender][rewardIndex] = redeemAmount;

        emit RedeemSnapshotReward(
            epoch,
            rewardIndex,
            to,
            snapshotId,
            snapshotBalance,
            redeemAmount
        );

        ERC20(e.rewards[rewardIndex]).safeTransfer(to, redeemAmount);
    }

    /**
        @notice Redeem Futures rewards as a rpCVX holder for an epoch
        @param  epoch  uint256  Epoch (ERC1155 token id)
        @param  to     address  Futures rewards recipient
    */
    function redeemFuturesRewards(uint256 epoch, address to)
        external
        whenNotPaused
        nonReentrant
    {
        if (epoch == 0) revert ZeroAmount();

        address[] memory r = epochs[epoch].rewards;

        emit RedeemFuturesRewards(epoch, to, r);

        // Check msg.sender rpCVX balance
        uint256 rpCvxBalance = rpCvx.balanceOf(msg.sender, epoch);
        if (rpCvxBalance == 0) revert InsufficientBalance();

        // Store rpCVX total supply before burning
        uint256 rpCvxTotalSupply = rpCvx.totalSupply(epoch);

        // Burn rpCVX tokens
        rpCvx.burn(msg.sender, epoch, rpCvxBalance);

        uint256[] memory f = epochs[epoch].futuresRewards;
        uint8 rLen = uint8(r.length);

        // Loop over rewards and transfer the amount entitled to the rpCVX token holder
        for (uint8 i; i < rLen; ++i) {
            // Proportionate to the % of rpCVX owned out of the rpCVX total supply
            ERC20(r[i]).safeTransfer(
                to,
                (f[i] * rpCvxBalance) / rpCvxTotalSupply
            );
        }
    }

    /**
        @notice Exchange one futures token for another
        @param  epoch   uint256  Epoch (ERC1155 token id)
        @param  to      address  Futures rewards recipient
        @param  amount  uint256  Futures rewards recipient
        @param  i       Futures  Futures token to burn
        @param  o       Futures  Futures token to mint
    */
    function exchangeFutures(
        uint256 epoch,
        address to,
        uint256 amount,
        Futures i,
        Futures o
    ) external whenNotPaused {
        // Users can only exchange futures tokens for future epochs
        if (epoch <= getCurrentEpoch()) revert PastExchangePeriod();
        if (amount == 0) revert ZeroAmount();

        ERC1155PresetMinterSupply futuresIn = i == Futures.Vote ? vpCvx : rpCvx;
        ERC1155PresetMinterSupply futuresOut = o == Futures.Reward
            ? rpCvx
            : vpCvx;

        emit ExchangeFutures(epoch, to, amount, i, o);

        // Validates `amount` (balance)
        futuresIn.burn(msg.sender, epoch, amount);

        // Validates `to`
        futuresOut.mint(to, epoch, amount, "");
    }
}
