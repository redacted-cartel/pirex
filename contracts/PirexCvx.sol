// SPDX-License-Identifier: MIT
pragma solidity 0.8.12;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ERC20Snapshot} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Snapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1155PresetMinterSupply} from "./ERC1155PresetMinterSupply.sol";
import {IVotiumMultiMerkleStash} from "./interfaces/IVotiumMultiMerkleStash.sol";
import {PirexCvxConvex} from "./PirexCvxConvex.sol";
import {PirexFees} from "./PirexFees.sol";
import {UnionPirexVault} from "./UnionPirexVault.sol";
import {ICvxLocker} from "./interfaces/ICvxLocker.sol";

contract PirexCvx is ReentrancyGuard, ERC20Snapshot, PirexCvxConvex {
    using SafeERC20 for ERC20;

    /**
        @notice Epoch details
        @notice Reward/snapshotRewards/futuresRewards indexes are associated with 1 reward
        @param  snapshotId               uint256    Snapshot id
        @param  rewards                  address[]  Rewards
        @param  snapshotRewards          uint256[]  Snapshot reward amounts
        @param  futuresRewards           uint256[]  Futures reward amounts
        @param  redeemedSnapshotRewards  mapping    Redeemed snapshot rewards
     */
    struct Epoch {
        uint256 snapshotId;
        address[] rewards;
        uint256[] snapshotRewards;
        uint256[] futuresRewards;
        mapping(address => uint256) redeemedSnapshotRewards;
    }

    /**
        @notice Queued fee changes
        @param  newFee          uint32   New fee
        @param  effectiveAfter  uint224  Timestamp after which new fee could take effect
     */
    struct QueuedFee {
        uint32 newFee;
        uint224 effectiveAfter;
    }

    // Users can choose between the two futures tokens when staking or initiating a redemption
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

    // Unused ERC1155 `data` param value
    bytes private constant UNUSED_1155_DATA = "";

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
        uint256 rounds,
        Futures indexed f,
        uint256 assets,
        address indexed receiver
    );
    event Deposit(
        uint256 assets,
        address indexed receiver,
        bool indexed shouldCompound
    );
    event InitiateRedemptions(
        uint256[] lockIndexes,
        Futures indexed f,
        uint256[] assets,
        address indexed receiver
    );
    event Redeem(
        uint256[] unlockTimes,
        uint256[] assets,
        address indexed receiver
    );
    event Stake(
        uint256 rounds,
        Futures indexed f,
        uint256 assets,
        address indexed receiver
    );
    event Unstake(uint256 id, uint256 assets, address indexed receiver);
    event ClaimMiscRewards(uint256 timestamp, ConvexReward[] rewards);
    event ClaimVotiumReward(
        address indexed token,
        uint256 index,
        uint256 amount
    );
    event RedeemSnapshotRewards(
        uint256 indexed epoch,
        uint256[] rewardIndexes,
        address indexed receiver,
        uint256 snapshotBalance,
        uint256 snapshotSupply
    );
    event RedeemFuturesRewards(
        uint256 indexed epoch,
        address indexed receiver,
        address[] rewards
    );
    event ExchangeFutures(
        uint256 indexed epoch,
        uint256 amount,
        address indexed receiver,
        Futures f
    );

    error ZeroAmount();
    error BeforeUnlock();
    error InsufficientBalance();
    error AlreadyRedeemed();
    error InsufficientRedemptionAllowance();
    error PastExchangePeriod();
    error InvalidNewFee();
    error BeforeEffectiveTimestamp();
    error BeforeStakingExpiry();
    error InvalidEpoch();
    error EmptyArray();
    error MismatchedArrayLengths();
    error NoRewards();

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
        epochs[getCurrentEpoch()].snapshotId = _snapshot();

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
        @param  f       enum    Fee
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
        @param  f  enum  Fee
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
        @return snapshotId       uint256    Snapshot id
        @return rewards          address[]  Reward tokens
        @return snapshotRewards  uint256[]  Snapshot reward amounts
        @return futuresRewards   uint256[]  Futures reward amounts
     */
    function getEpoch(uint256 epoch)
        external
        view
        returns (
            uint256 snapshotId,
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
        @param  rounds    uint256    Rounds (i.e. Convex voting rounds)
        @param  f         enum     Futures enum
        @param  assets    uint256  Futures amount
        @param  receiver  address  Receives futures
    */
    function _mintFutures(
        uint256 rounds,
        Futures f,
        uint256 assets,
        address receiver
    ) internal {
        emit MintFutures(rounds, f, assets, receiver);

        ERC1155PresetMinterSupply token = f == Futures.Vote ? vpCvx : rpCvx;
        uint256 startingEpoch = getCurrentEpoch() + EPOCH_DURATION;
        uint256[] memory tokenIds = new uint256[](rounds);
        uint256[] memory amounts = new uint256[](rounds);

        for (uint256 i; i < rounds; ++i) {
            tokenIds[i] = startingEpoch + i * EPOCH_DURATION;
            amounts[i] = assets;
        }

        token.mintBatch(receiver, tokenIds, amounts, UNUSED_1155_DATA);
    }

    /**
        @notice Calculate rewards
        @param  feePercent       uint32   Reward fee percent
        @param  snapshotSupply   uint256  pCVX supply for the current snapshot id
        @param  rpCvxSupply      uint256  rpCVX supply for the current epoch
        @param  received         uint256  Received amount
        @return rewardFee        uint256  Fee for protocol
        @return snapshotRewards  uint256  Rewards for pCVX token holders
        @return futuresRewards   uint256  Rewards for futures token holders
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
        @notice Claim a single Votium reward
        @param  e            Epoch      Epoch details
        @param  rpCvxSupply  uint256    rpCVX supply
        @param  token        address    Reward token address
        @param  index        uint256    Merkle tree node index
        @param  amount       uint256    Reward token amount
        @param  merkleProof  bytes32[]  Merkle proof
    */
    function _claimVotiumReward(
        Epoch storage e,
        uint256 rpCvxSupply,
        address token,
        uint256 index,
        uint256 amount,
        bytes32[] memory merkleProof
    ) internal {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

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
                totalSupplyAt(e.snapshotId),
                rpCvxSupply,
                t.balanceOf(address(this)) - prevBalance
            );

        // Add reward token address and snapshot/futuresRewards amounts (same index for all)
        e.rewards.push(token);
        e.snapshotRewards.push(snapshotRewards);
        e.futuresRewards.push(futuresRewards);

        // Distribute fees
        t.safeIncreaseAllowance(address(pirexFees), rewardFee);
        pirexFees.distributeFees(address(this), token, rewardFee);
    }

    /**
        @notice Snapshot token balances for the current epoch
     */
    function takeEpochSnapshot() public whenNotPaused {
        uint256 currentEpoch = getCurrentEpoch();

        // If snapshot has not been set for current epoch, take snapshot
        if (epochs[currentEpoch].snapshotId == 0) {
            epochs[currentEpoch].snapshotId = _snapshot();
        }
    }

    /**
        @notice Deposit CVX
        @param  assets          uint256  CVX amount
        @param  receiver        address  Receives pCVX
        @param  shouldCompound  bool     Whether to auto-compound
     */
    function deposit(
        uint256 assets,
        address receiver,
        bool shouldCompound
    ) external whenNotPaused nonReentrant {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Perform epoch maintenance if necessary
        takeEpochSnapshot();

        // Mint pCVX - recipient depends on whether or not to compound
        _mint(shouldCompound ? address(this) : receiver, assets);

        emit Deposit(assets, receiver, shouldCompound);

        if (shouldCompound) {
            _approve(address(this), address(unionPirex), assets);

            // Deposit pCVX into pounder vault - user receives shares
            unionPirex.deposit(assets, receiver);
        }

        // Transfer CVX to self and approve for locking
        CVX.safeTransferFrom(msg.sender, address(this), assets);

        // Lock CVX
        _lock(assets);
    }

    /**
        @notice Initiate CVX redemption
        @param  lockData   ICvxLocker.LockedBalance  Locked balance index
        @param  f          enum                      Futures enum
        @param  assets     uint256                   pCVX amount
        @param  receiver   address                   Receives upCVX
        @param  feeMin     uint256                   Initiate redemption fee min
        @param  feeMax     uint256                   Initiate redemption fee max
        @return feeAmount  uint256                   Fee amount
     */
    function _initiateRedemption(
        ICvxLocker.LockedBalance memory lockData,
        Futures f,
        uint256 assets,
        address receiver,
        uint256 feeMin,
        uint256 feeMax
    ) internal returns (uint256 feeAmount) {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        uint256 unlockTime = lockData.unlockTime;
        uint256 lockAmount = lockData.amount;

        // Calculate the fee based on the duration a user has to wait before redeeming CVX
        uint256 waitTime = unlockTime - block.timestamp;
        uint256 feePercent = feeMax -
            (((feeMax - feeMin) * waitTime) / MAX_REDEMPTION_TIME);

        feeAmount = (assets * feePercent) / FEE_DENOMINATOR;

        uint256 postFeeAmount = assets - feeAmount;

        // Increment redemptions for this unlockTime to prevent over-redeeming
        redemptions[unlockTime] += postFeeAmount;

        // Check if there is any sufficient allowance after factoring in redemptions by others
        if (redemptions[unlockTime] > lockAmount)
            revert InsufficientRedemptionAllowance();

        // Track assets that needs to remain unlocked for redemptions
        outstandingRedemptions += postFeeAmount;

        // Mint upCVX with unlockTime as the id - validates `to`
        upCvx.mint(receiver, unlockTime, postFeeAmount, UNUSED_1155_DATA);

        // Determine how many futures notes rounds to mint
        uint256 rounds = waitTime / EPOCH_DURATION;

        // Check if the lock was in the first week/half of an epoch
        // Handle case where remaining time is between 1 and 2 weeks
        if (
            rounds == 0 &&
            unlockTime % EPOCH_DURATION != 0 &&
            waitTime > (EPOCH_DURATION / 2)
        ) {
            // Rounds is 0 if waitTime is between 1 and 2 weeks
            // Increment by 1 since user should receive 1 round of rewards
            unchecked {
                ++rounds;
            }
        }

        // Mint vpCVX or rpCVX (using assets as we do not take a fee from this)
        _mintFutures(rounds, f, assets, receiver);

        return feeAmount;
    }

    /**
        @notice Initiate CVX redemptions
        @param  lockIndexes  uint256[]    Locked balance index
        @param  f            enum       Futures enum
        @param  assets       uint256[]  pCVX amounts
        @param  receiver     address    Receives upCVX
     */
    function initiateRedemptions(
        uint256[] calldata lockIndexes,
        Futures f,
        uint256[] calldata assets,
        address receiver
    ) external whenNotPaused nonReentrant {
        uint256 lockLen = lockIndexes.length;
        if (lockLen == 0) revert EmptyArray();
        if (lockLen != assets.length) revert MismatchedArrayLengths();

        emit InitiateRedemptions(lockIndexes, f, assets, receiver);

        (, , , ICvxLocker.LockedBalance[] memory lockData) = cvxLocker
            .lockedBalances(address(this));
        uint256 totalAssets;
        uint256 feeAmount;
        uint256 feeMin = fees[Fees.RedemptionMin];
        uint256 feeMax = fees[Fees.RedemptionMax];

        for (uint256 i; i < lockLen; ++i) {
            totalAssets += assets[i];
            feeAmount += _initiateRedemption(
                lockData[lockIndexes[i]],
                f,
                assets[i],
                receiver,
                feeMin,
                feeMax
            );
        }

        // Burn pCVX - reverts if sender balance is insufficient
        _burn(msg.sender, totalAssets - feeAmount);

        // Allow PirexFees to distribute fees directly from sender
        _approve(msg.sender, address(pirexFees), feeAmount);

        // Distribute fees
        pirexFees.distributeFees(msg.sender, address(this), feeAmount);
    }

    /**
        @notice Redeem CVX for specified unlock times
        @param  unlockTimes  uint256[]  CVX unlock timestamps
        @param  assets       uint256[]  upCVX amounts
        @param  receiver     address    Receives CVX
     */
    function redeem(
        uint256[] calldata unlockTimes,
        uint256[] calldata assets,
        address receiver
    ) external whenNotPaused nonReentrant {
        uint256 unlockLen = unlockTimes.length;
        if (unlockLen == 0) revert EmptyArray();
        if (unlockLen != assets.length) revert MismatchedArrayLengths();
        if (receiver == address(0)) revert ZeroAddress();

        emit Redeem(unlockTimes, assets, receiver);

        uint256 totalAssets;

        for (uint256 i; i < unlockLen; ++i) {
            uint256 asset = assets[i];

            if (unlockTimes[i] > block.timestamp) revert BeforeUnlock();
            if (asset == 0) revert ZeroAmount();

            totalAssets += asset;
        }

        // Unlock and relock if balance is greater than outstandingRedemptions
        _relock();

        // Subtract redemption amount from outstanding CVX amount
        outstandingRedemptions -= totalAssets;

        // Reverts if sender has an insufficient amount of upCVX with unlockTime id
        upCvx.burnBatch(msg.sender, unlockTimes, assets);

        // Validates `to`
        CVX.safeTransfer(receiver, totalAssets);
    }

    /**
        @notice Stake pCVX
        @param  rounds    uint256    Rounds (i.e. Convex voting rounds)
        @param  f         enum     Futures enum
        @param  assets    uint256  pCVX amount
        @param  receiver  address  Receives spCVX
    */
    function stake(
        uint256 rounds,
        Futures f,
        uint256 assets,
        address receiver
    ) external whenNotPaused nonReentrant {
        if (rounds == 0) revert ZeroAmount();
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Burn pCVX
        _burn(msg.sender, assets);

        emit Stake(rounds, f, assets, receiver);

        // Mint spCVX with the stake expiry timestamp as the id
        spCvx.mint(
            receiver,
            getCurrentEpoch() + EPOCH_DURATION * rounds,
            assets,
            UNUSED_1155_DATA
        );

        _mintFutures(rounds, f, assets, receiver);
    }

    /**
        @notice Unstake pCVX
        @param  id        uint256  spCVX id (an epoch timestamp)
        @param  assets    uint256  spCVX amount
        @param  receiver  address  Receives pCVX
    */
    function unstake(
        uint256 id,
        uint256 assets,
        address receiver
    ) external whenNotPaused nonReentrant {
        if (id > block.timestamp) revert BeforeStakingExpiry();
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        // Mint pCVX for receiver
        _mint(receiver, assets);

        emit Unstake(id, assets, receiver);

        // Burn spCVX from sender
        spCvx.burn(msg.sender, id, assets);
    }

    /**
        @notice Claim multiple Votium rewards
        @param  tokens        address[]    Reward token addresses
        @param  indexes       uint256[]    Merkle tree node indexes
        @param  amounts       uint256[]    Reward token amounts
        @param  merkleProofs  bytes32[][]  Merkle proofs
    */
    function claimVotiumRewards(
        address[] calldata tokens,
        uint256[] calldata indexes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs
    ) external whenNotPaused nonReentrant {
        uint256 tLen = tokens.length;
        if (tLen == 0) revert EmptyArray();
        if (
            !(tLen == indexes.length &&
                indexes.length == amounts.length &&
                amounts.length == merkleProofs.length)
        ) revert MismatchedArrayLengths();

        // Take snapshot before claiming rewards, if necessary
        takeEpochSnapshot();

        uint256 currentEpoch = getCurrentEpoch();
        Epoch storage e = epochs[currentEpoch];
        uint256 rpCvxSupply = rpCvx.totalSupply(currentEpoch);

        for (uint256 i; i < tLen; ++i) {
            _claimVotiumReward(
                e,
                rpCvxSupply,
                tokens[i],
                indexes[i],
                amounts[i],
                merkleProofs[i]
            );
        }
    }

    /**
        @notice Claim misc. rewards (e.g. emissions) and distribute to stakeholders
     */
    function claimMiscRewards() external nonReentrant {
        // Get claimable rewards and balances
        ConvexReward[] memory c = _claimableRewards();

        emit ClaimMiscRewards(block.timestamp, c);

        // Claim rewards from Convex
        _getReward();

        uint256 cLen = c.length;

        // Iterate over rewards and distribute to stakeholders (rlBTRFLY, Redacted, and Pirex)
        for (uint256 i; i < cLen; ++i) {
            if (c[i].amount == 0) continue;

            ERC20 t = ERC20(c[i].token);
            uint256 received = t.balanceOf(address(this)) - c[i].balance;

            // Distribute fees
            t.safeIncreaseAllowance(address(pirexFees), received);
            pirexFees.distributeFees(address(this), c[i].token, received);
        }
    }

    /**
        @notice Redeem multiple Snapshot rewards as a pCVX holder
        @param  epoch          uint256    Epoch
        @param  rewardIndexes  uint256[]  Reward token indexes
        @param  receiver       address    Receives snapshot rewards
    */
    function redeemSnapshotRewards(
        uint256 epoch,
        uint256[] calldata rewardIndexes,
        address receiver
    ) external whenNotPaused nonReentrant {
        if (epoch == 0) revert InvalidEpoch();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 rewardLen = rewardIndexes.length;
        if (rewardLen == 0) revert EmptyArray();

        Epoch storage e = epochs[epoch];

        // Check whether msg.sender maintained a positive balance before the snapshot
        uint256 snapshotId = e.snapshotId;
        uint256 snapshotBalance = balanceOfAt(msg.sender, snapshotId);
        uint256 snapshotSupply = totalSupplyAt(snapshotId);
        if (snapshotBalance == 0) revert InsufficientBalance();

        // Used to update the redeemed flag locally before updating to the storage all at once for gas efficiency
        uint256 redeemed = e.redeemedSnapshotRewards[msg.sender];

        emit RedeemSnapshotRewards(
            epoch,
            rewardIndexes,
            receiver,
            snapshotBalance,
            snapshotSupply
        );

        for (uint256 i; i < rewardLen; ++i) {
            uint256 index = rewardIndexes[i];
            uint256 indexRedeemed = (1 << index);
            if ((redeemed & indexRedeemed) != 0) revert AlreadyRedeemed();
            redeemed |= indexRedeemed;

            ERC20(e.rewards[index]).safeTransfer(
                receiver,
                (e.snapshotRewards[index] * snapshotBalance) / snapshotSupply
            );
        }

        // Update the redeemed rewards flag in storage to prevent double claimings
        e.redeemedSnapshotRewards[msg.sender] = redeemed;
    }

    /**
        @notice Redeem Futures rewards for rpCVX holders for an epoch
        @param  epoch     uint256  Epoch (ERC1155 token id)
        @param  receiver  address  Receives futures rewards
    */
    function redeemFuturesRewards(uint256 epoch, address receiver)
        external
        whenNotPaused
        nonReentrant
    {
        if (epoch == 0) revert InvalidEpoch();
        if (epoch > getCurrentEpoch()) revert InvalidEpoch();
        if (receiver == address(0)) revert ZeroAddress();

        // Prevent users from burning their futures notes before rewards are claimed
        address[] memory r = epochs[epoch].rewards;
        if (r.length == 0) revert NoRewards();

        emit RedeemFuturesRewards(epoch, receiver, r);

        // Check sender rpCVX balance
        uint256 rpCvxBalance = rpCvx.balanceOf(msg.sender, epoch);
        if (rpCvxBalance == 0) revert InsufficientBalance();

        // Store rpCVX total supply before burning
        uint256 rpCvxTotalSupply = rpCvx.totalSupply(epoch);

        // Burn rpCVX tokens
        rpCvx.burn(msg.sender, epoch, rpCvxBalance);

        uint256[] memory f = epochs[epoch].futuresRewards;
        uint256 rLen = r.length;

        // Loop over rewards and transfer the amount entitled to the rpCVX token holder
        for (uint256 i; i < rLen; ++i) {
            // Proportionate to the % of rpCVX owned out of the rpCVX total supply
            ERC20(r[i]).safeTransfer(
                receiver,
                (f[i] * rpCvxBalance) / rpCvxTotalSupply
            );
        }
    }

    /**
        @notice Exchange one futures token for another
        @param  epoch     uint256  Epoch (ERC1155 token id)
        @param  amount    uint256  Exchange amount
        @param  receiver  address  Receives futures token
        @param  f         enum     Futures enum
    */
    function exchangeFutures(
        uint256 epoch,
        uint256 amount,
        address receiver,
        Futures f
    ) external whenNotPaused {
        // Users can only exchange futures tokens for future epochs
        if (epoch <= getCurrentEpoch()) revert PastExchangePeriod();
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        ERC1155PresetMinterSupply futuresIn = f == Futures.Vote ? vpCvx : rpCvx;
        ERC1155PresetMinterSupply futuresOut = f == Futures.Vote
            ? rpCvx
            : vpCvx;

        emit ExchangeFutures(epoch, amount, receiver, f);

        // Validates `amount` (balance)
        futuresIn.burn(msg.sender, epoch, amount);

        // Validates `to`
        futuresOut.mint(receiver, epoch, amount, UNUSED_1155_DATA);
    }
}
