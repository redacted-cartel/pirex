import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import {
  ConvexToken,
  PxCvx,
  PirexCvx,
  UnionPirexVault,
  UnionPirexStrategy,
  Crv,
  MultiMerkleStash,
} from '../typechain-types';
import {
  callAndReturnEvents,
  increaseBlockTimestamp,
  toBN,
  toBN2,
  validateEvent,
  parseLog,
} from './helpers';
import { BalanceTree } from '../lib/merkle';

// Tests foundational units outside of the actual deposit flow
describe('PirexCvx-UnionPirex*', function () {
  let admin: SignerWithAddress;
  let notAdmin: SignerWithAddress;
  let pirexCvx: PirexCvx;
  let pxCvx: PxCvx;
  let unionPirex: UnionPirexVault;
  let unionPirexStrategy: UnionPirexStrategy;
  let cvx: ConvexToken;
  let crv: Crv;
  let zeroAddress: string;
  let contractEnum: any;
  let votiumMultiMerkleStash: MultiMerkleStash;

  const fourteenDays = 1209600;

  before(async function () {
    ({
      admin,
      notAdmin,
      cvx,
      pirexCvx,
      pxCvx,
      unionPirex,
      unionPirexStrategy,
      zeroAddress,
      contractEnum,
      crv,
      votiumMultiMerkleStash,
    } = this);

    if (await pirexCvx.paused()) await pirexCvx.setPauseState(false);

    if ((await pirexCvx.unionPirex()) === zeroAddress) {
      await pirexCvx.setContract(contractEnum.unionPirex, unionPirex.address);
    }

    // Mint pxCVX for testing
    await cvx.approve(pirexCvx.address, toBN(50e18));
    await pirexCvx.deposit(toBN(50e18), admin.address, false, zeroAddress);

    // For making pxCVX deposits outside of the pirexCvx.deposit flow
    await pxCvx.approve(unionPirex.address, toBN2(1000e18).toFixed(0));
  });

  describe('UnionPirexVault: initial state', function () {
    it('Should have initialized state variables', async function () {
      const MAX_WITHDRAWAL_PENALTY = await unionPirex.MAX_WITHDRAWAL_PENALTY();
      const MAX_PLATFORM_FEE = await unionPirex.MAX_PLATFORM_FEE();
      const FEE_DENOMINATOR = await unionPirex.FEE_DENOMINATOR();
      const withdrawalPenalty = await unionPirex.withdrawalPenalty();
      const platformFee = await unionPirex.platformFee();

      expect(MAX_WITHDRAWAL_PENALTY).to.equal(500);
      expect(MAX_PLATFORM_FEE).to.equal(2000);
      expect(FEE_DENOMINATOR).to.equal(10000);
      expect(withdrawalPenalty).to.equal(300);
      expect(platformFee).to.equal(1000);
    });
  });

  describe('UnionPirexStrategy: initial state', function () {
    it('Should have initialized state variables', async function () {
      const rewardsDuration = await unionPirexStrategy.rewardsDuration();

      expect(rewardsDuration).to.equal(fourteenDays);
    });
  });

  describe('UnionPirexVault: constructor', function () {
    it('Should set up contract state', async function () {
      const asset = await unionPirex.asset();
      const name = await unionPirex.name();
      const symbol = await unionPirex.symbol();

      expect(asset).to.equal(pxCvx.address);
      expect(name).to.equal('Union Pirex');
      expect(symbol).to.equal('uCVX');
    });
  });

  describe('UnionPirexStrategy: constructor', function () {
    it('Should set up contract state', async function () {
      const _pirexCvx = await unionPirexStrategy.pirexCvx();
      const vault = await unionPirexStrategy.vault();
      const token = await unionPirexStrategy.token();
      const distributor = await unionPirexStrategy.distributor();
      const pirexCvx2 = await unionPirexStrategy.pirexCvx();
      const vault2 = await unionPirexStrategy.vault();
      const token2 = await unionPirexStrategy.token();
      const distributor2 = await unionPirexStrategy.distributor();

      expect(_pirexCvx).to.equal(pirexCvx.address);
      expect(vault).to.equal(unionPirex.address);
      expect(token).to.equal(pxCvx.address);
      expect(distributor).to.equal(admin.address);
      expect(pirexCvx2).to.equal(_pirexCvx);
      expect(vault2).to.equal(vault);
      expect(token2).to.equal(token);
      expect(distributor2).to.equal(distributor);
    });
  });

  describe('UnionPirexVault: setWithdrawalPenalty', function () {
    it('Should revert if withdrawal penalty is greater than max', async function () {
      const max = await unionPirex.MAX_WITHDRAWAL_PENALTY();
      const invalidPenalty = max.add(1);

      await expect(
        unionPirex.setWithdrawalPenalty(invalidPenalty)
      ).to.be.revertedWith('ExceedsMax()');
    });

    it('Should revert if not called by owner', async function () {
      const penalty = toBN(1);

      await expect(
        unionPirex.connect(notAdmin).setWithdrawalPenalty(penalty)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('Should set withdrawal penalty', async function () {
      const penaltyBefore = await unionPirex.withdrawalPenalty();
      const penalty = toBN(100);
      const events = await callAndReturnEvents(
        unionPirex.setWithdrawalPenalty,
        [penalty]
      );
      const setEvent = events[0];
      const penaltyAfter = await unionPirex.withdrawalPenalty();

      expect(penaltyBefore).to.not.equal(penaltyAfter);
      expect(penaltyAfter).to.equal(penalty);

      validateEvent(setEvent, 'WithdrawalPenaltyUpdated(uint256)', {
        penalty,
      });
    });
  });

  describe('UnionPirexVault: setPlatform', function () {
    it('Should revert if platform is zero address', async function () {
      const invalidPlatform = zeroAddress;

      await expect(unionPirex.setPlatform(invalidPlatform)).to.be.revertedWith(
        'ZeroAddress()'
      );
    });

    it('Should revert if not called by owner', async function () {
      const platform = admin.address;

      await expect(
        unionPirex.connect(notAdmin).setPlatform(platform)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('Should set platform', async function () {
      const platformBefore = await unionPirex.platform();
      const platform = admin.address;
      const events = await callAndReturnEvents(unionPirex.setPlatform, [
        platform,
      ]);
      const setEvent = events[0];
      const platformAfter = await unionPirex.platform();

      expect(platformBefore).to.not.equal(platformAfter);
      expect(platformAfter).to.equal(platform);
      validateEvent(setEvent, 'PlatformUpdated(address)', {
        _platform: platform,
      });
    });
  });

  describe('UnionPirexVault: setStrategy', function () {
    it('Should revert if not called by owner', async function () {
      const strategy = unionPirexStrategy.address;

      await expect(
        unionPirex.connect(notAdmin).setStrategy(strategy)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('Should revert if strategy is already set', async function () {
      const strategy = unionPirexStrategy.address;

      await expect(unionPirex.setStrategy(strategy)).to.be.revertedWith(
        'AlreadySet()'
      );
    });
  });

  describe('UnionPirexStrategy: notifyRewardAmount', function () {
    it('Should revert if not called by distributor', async function () {
      const distributor = await unionPirexStrategy.distributor();

      expect(notAdmin.address).to.not.equal(distributor);
      await expect(
        unionPirexStrategy.connect(notAdmin).notifyRewardAmount()
      ).to.be.revertedWith('Distributor only');
    });

    it('Should set the reward distribution parameters', async function () {
      const reward = toBN(1e18);
      const rewardRateBefore = await unionPirexStrategy.rewardRate();
      const lastUpdateTimeBefore = await unionPirexStrategy.lastUpdateTime();
      const periodFinishBefore = await unionPirexStrategy.periodFinish();

      await cvx.approve(pirexCvx.address, reward);

      // Get pxCVX and deposit as vault reward
      await pirexCvx.deposit(reward, admin.address, false, zeroAddress);
      await pxCvx.transfer(unionPirexStrategy.address, reward);

      const events = await callAndReturnEvents(
        unionPirexStrategy.notifyRewardAmount,
        []
      );
      const rewardAddedEvent = events[0];
      const rewardRateAfter = await unionPirexStrategy.rewardRate();
      const lastUpdateTimeAfter = await unionPirexStrategy.lastUpdateTime();
      const periodFinishAfter = await unionPirexStrategy.periodFinish();

      expect(rewardRateAfter).to.not.equal(rewardRateBefore);
      expect(lastUpdateTimeAfter).to.not.equal(lastUpdateTimeBefore);
      expect(periodFinishAfter).to.not.equal(periodFinishBefore);
      expect(rewardRateAfter).to.equal(reward.div(fourteenDays));

      validateEvent(rewardAddedEvent, 'RewardAdded(uint256)', {
        reward,
      });
    });
  });

  describe('UnionPirexStrategy: setDistributor', function () {
    it('Should revert if not called by owner', async function () {
      const owner = await unionPirexStrategy.owner();

      expect(notAdmin.address).to.not.equal(owner);
      await expect(
        unionPirexStrategy.connect(notAdmin).setDistributor(notAdmin.address)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('Should should set a new distributor', async function () {
      const distributorBefore = await unionPirexStrategy.distributor();
      const distributor = notAdmin.address;

      await unionPirexStrategy.setDistributor(distributor);

      const distributorAfter = await unionPirexStrategy.distributor();

      // Set back to original for testing convenience
      await unionPirexStrategy.setDistributor(admin.address);

      expect(distributorBefore).to.not.equal(distributorAfter);
      expect(distributorBefore).to.equal(admin.address);
      expect(distributorAfter).to.equal(distributor);
    });
  });

  describe('UnionPirexVault: harvest', function () {
    before(async function () {
      await increaseBlockTimestamp(fourteenDays);
    });

    it('Should harvest rewards', async function () {
      // We can reliably count on `earned`'s result since the reward distribution is finished
      const [, rewards] = await unionPirexStrategy.totalSupplyWithRewards();
      const platform = await unionPirex.platform();
      const platformBalanceBefore = await pxCvx.balanceOf(platform);
      const totalAssetsBefore = await unionPirex.totalAssets();
      const totalSupplyBefore = await unionPirex.totalSupply();
      const events = await callAndReturnEvents(unionPirex.harvest, []);
      const rewardTransferEvent = events[0];
      const rewardPaidEvent = parseLog(unionPirexStrategy, events[1]);
      const harvestEvent = events[2];
      const feeTransferEvent = events[3];
      const stakeTransferEvent = events[4];
      const stakeEvent = parseLog(
        unionPirexStrategy,
        events[events.length - 1]
      );
      const totalAssetsAfter = await unionPirex.totalAssets();
      const totalSupplyAfter = await unionPirex.totalSupply();
      const platformBalanceAfter = await pxCvx.balanceOf(platform);
      const feeAmount = rewards
        .mul(await unionPirex.platformFee())
        .div(await unionPirex.FEE_DENOMINATOR());
      const stakeAmount = rewards.sub(feeAmount);

      // The staking contract's calculations works out to less than 1e18 (notified reward amount)
      // Should still be greater than 99.5% of the notified reward amount
      expect(rewards.gt(toBN(1e18).mul(995).div(1000))).to.equal(true);
      expect(platformBalanceAfter).to.equal(
        platformBalanceBefore.add(feeAmount)
      );
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);

      // totalAssets includes earned rewards, totalAssetsAfter is less than totalAssetsBefore (after fees)
      expect(totalAssetsAfter).to.equal(totalAssetsBefore);

      validateEvent(rewardTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirexStrategy.address,
        to: unionPirex.address,
        amount: rewards,
      });

      validateEvent(rewardPaidEvent, 'RewardPaid(uint256)', {
        reward: rewards,
      });

      validateEvent(harvestEvent, 'Harvest(address,uint256)', {
        caller: admin.address,
        value: rewards,
      });

      validateEvent(feeTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: platform,
        amount: feeAmount,
      });

      validateEvent(stakeTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: unionPirexStrategy.address,
        amount: stakeAmount,
      });

      validateEvent(stakeEvent, 'Staked(uint256)', {
        amount: stakeAmount,
      });
    });
  });

  describe('UnionPirexVault: deposit', function () {
    it('Should revert if assets is zero', async function () {
      const invalidAssets = 0;
      const receiver = admin.address;

      await expect(
        unionPirex.deposit(invalidAssets, receiver)
      ).to.be.revertedWith('ZERO_SHARES');
    });

    it('Should revert if receiver is zero address', async function () {
      const assets = 1;
      const invalidReceiver = zeroAddress;

      await expect(
        unionPirex.deposit(assets, invalidReceiver)
      ).to.be.revertedWith('ZERO_SHARES');
    });

    it('Should deposit pxCVX', async function () {
      const assets = (await pxCvx.balanceOf(admin.address)).div(10);
      const receiver = admin.address;
      const totalAssetsBefore = await unionPirex.totalAssets();
      const totalSupplyBefore = await unionPirex.totalSupply();
      const sharesBefore = await unionPirex.balanceOf(receiver);
      const expectedShares = await unionPirex.previewDeposit(assets);
      const events = await callAndReturnEvents(unionPirex.deposit, [
        assets,
        receiver,
      ]);
      const depositTransferEvent = events[0];
      const sharesMintEvent = events[1];
      const depositEvent = events[2];
      const stakeTransferEvent = events[3];
      const totalAssetsAfter = await unionPirex.totalAssets();
      const totalSupplyAfter = await unionPirex.totalSupply();
      const sharesAfter = await unionPirex.balanceOf(receiver);

      expect(totalAssetsBefore).to.not.equal(totalAssetsAfter);
      expect(totalAssetsAfter).to.equal(totalAssetsBefore.add(assets));
      expect(totalSupplyBefore).to.not.equal(totalSupplyAfter);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore.add(expectedShares));
      expect(sharesBefore).to.not.equal(sharesAfter);
      expect(sharesAfter).to.equal(sharesBefore.add(expectedShares));

      validateEvent(depositTransferEvent, 'Transfer(address,address,uint256)', {
        from: admin.address,
        to: unionPirex.address,
        amount: assets,
      });

      validateEvent(sharesMintEvent, 'Transfer(address,address,uint256)', {
        from: zeroAddress,
        to: receiver,
        amount: expectedShares,
      });

      validateEvent(depositEvent, 'Deposit(address,address,uint256,uint256)', {
        caller: admin.address,
        owner: receiver,
        assets,
        shares: expectedShares,
      });

      validateEvent(stakeTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: unionPirexStrategy.address,
        amount: assets,
      });
    });
  });

  describe('UnionPirexVault: mint', function () {
    it('Should revert if assets is zero', async function () {
      const invalidShares = 0;
      const receiver = admin.address;

      await expect(unionPirex.mint(invalidShares, receiver)).to.be.revertedWith(
        'Cannot stake 0'
      );
    });

    it('Should mint uCVX', async function () {
      const shares = toBN(1e18);
      const receiver = admin.address;
      const totalAssetsBefore = await unionPirex.totalAssets();
      const totalSupplyBefore = await unionPirex.totalSupply();
      const sharesBefore = await unionPirex.balanceOf(receiver);
      const expectedAssets = await unionPirex.previewMint(shares);
      const events = await callAndReturnEvents(unionPirex.mint, [
        shares,
        receiver,
      ]);
      const depositTransferEvent = events[0];
      const sharesMintEvent = events[1];
      const depositEvent = events[2];
      const stakeTransferEvent = events[3];
      const totalAssetsAfter = await unionPirex.totalAssets();
      const totalSupplyAfter = await unionPirex.totalSupply();
      const sharesAfter = await unionPirex.balanceOf(receiver);

      expect(totalAssetsBefore).to.not.equal(totalAssetsAfter);
      expect(totalAssetsAfter).to.equal(totalAssetsBefore.add(expectedAssets));
      expect(totalSupplyBefore).to.not.equal(totalSupplyAfter);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore.add(shares));
      expect(sharesBefore).to.not.equal(sharesAfter);
      expect(sharesAfter).to.equal(sharesBefore.add(shares));

      validateEvent(depositTransferEvent, 'Transfer(address,address,uint256)', {
        from: admin.address,
        to: unionPirex.address,
        amount: expectedAssets,
      });

      validateEvent(sharesMintEvent, 'Transfer(address,address,uint256)', {
        from: zeroAddress,
        to: receiver,
        amount: shares,
      });

      validateEvent(depositEvent, 'Deposit(address,address,uint256,uint256)', {
        caller: admin.address,
        owner: receiver,
        assets: expectedAssets,
        shares,
      });

      validateEvent(stakeTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: unionPirexStrategy.address,
        amount: expectedAssets,
      });
    });
  });

  describe('UnionPirexVault: withdraw', function () {
    before(async function () {
      await pxCvx.transfer(unionPirexStrategy.address, toBN(1e18));
      await unionPirexStrategy.notifyRewardAmount();
      await increaseBlockTimestamp(fourteenDays);
    });

    it('Should revert if assets is zero', async function () {
      const invalidAssets = 0;
      const receiver = admin.address;
      const owner = admin.address;

      await expect(
        unionPirex.withdraw(invalidAssets, receiver, owner)
      ).to.be.revertedWith('Cannot withdraw 0');
    });

    it('Should withdraw pxCVX', async function () {
      const assets = toBN(1e18);
      const receiver = admin.address;
      const owner = admin.address;
      const totalAssetsBefore = await unionPirex.totalAssets();
      const totalSupplyBefore = await unionPirex.totalSupply();
      const sharesBefore = await unionPirex.balanceOf(receiver);
      const expectedShares = await unionPirex.previewWithdraw(assets);
      const events = await callAndReturnEvents(unionPirex.withdraw, [
        assets,
        receiver,
        owner,
      ]);
      const withdrawTransferEvent = events[0];
      const withdrawnEvent = parseLog(unionPirexStrategy, events[1]);
      const sharesBurnEvent = events[2];
      const withdrawEvent = events[3];
      const pxCvxTransferEvent = events[4];
      const totalAssetsAfter = await unionPirex.totalAssets();
      const totalSupplyAfter = await unionPirex.totalSupply();
      const sharesAfter = await unionPirex.balanceOf(receiver);

      expect(totalAssetsBefore).to.not.equal(totalAssetsAfter);
      expect(totalAssetsAfter).to.equal(totalAssetsBefore.sub(assets));
      expect(totalSupplyBefore).to.not.equal(totalSupplyAfter);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore.sub(expectedShares));
      expect(sharesBefore).to.not.equal(sharesAfter);
      expect(sharesAfter).to.equal(sharesBefore.sub(expectedShares));

      validateEvent(
        withdrawTransferEvent,
        'Transfer(address,address,uint256)',
        {
          from: unionPirexStrategy.address,
          to: unionPirex.address,
          amount: assets,
        }
      );

      validateEvent(withdrawnEvent, 'Withdrawn(uint256)', {
        amount: assets,
      });

      validateEvent(sharesBurnEvent, 'Transfer(address,address,uint256)', {
        from: owner,
        to: zeroAddress,
        amount: expectedShares,
      });

      validateEvent(
        withdrawEvent,
        'Withdraw(address,address,address,uint256,uint256)',
        {
          caller: admin.address,
          receiver,
          owner,
          assets,
          shares: expectedShares,
        }
      );

      validateEvent(pxCvxTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: receiver,
        amount: assets,
      });
    });
  });

  describe('UnionPirexVault: redeem', function () {
    it('Should revert if assets is zero', async function () {
      const invalidShares = 0;
      const receiver = admin.address;
      const owner = admin.address;

      await expect(
        unionPirex.redeem(invalidShares, receiver, owner)
      ).to.be.revertedWith('ZERO_ASSETS');
    });

    it('Should revert if owner is zero address', async function () {
      const shares = 1;
      const receiver = admin.address;
      const invalidOwner = zeroAddress;

      await expect(
        unionPirex.redeem(shares, receiver, invalidOwner)
      ).to.be.revertedWith('0x11');
    });

    it('Should redeem pxCVX', async function () {
      const sharesBefore = await unionPirex.balanceOf(admin.address);
      const receiver = notAdmin.address;
      const owner = admin.address;
      const distributor = admin.address;
      const totalAssetsBefore = await unionPirex.totalAssets();
      const totalSupplyBefore = await unionPirex.totalSupply();
      const pxCvxBeforeReceiver = await pxCvx.balanceOf(receiver);
      const pxCvxBeforeDistributor = await pxCvx.balanceOf(distributor);
      const expectedAssets = await unionPirex.previewRedeem(sharesBefore);
      const [, rewards] = await unionPirexStrategy.totalSupplyWithRewards();
      const feeAmount = rewards
        .mul(await unionPirex.platformFee())
        .div(await unionPirex.FEE_DENOMINATOR());
      const events = await callAndReturnEvents(unionPirex.redeem, [
        sharesBefore,
        receiver,
        owner,
      ]);
      const rewardTransferEvent = events[0];
      const getRewardEvent = parseLog(unionPirexStrategy, events[1]);
      const harvestEvent = events[2];
      const feeTransferEvent = events[3];
      const stakeTransferEvent = events[4];
      const stakedEvent = parseLog(unionPirexStrategy, events[5]);
      const withdrawEvent = events[9];
      const sharesAfter = await unionPirex.balanceOf(admin.address);
      const totalAssetsAfter = await unionPirex.totalAssets();
      const totalSupplyAfter = await unionPirex.totalSupply();
      const pxCvxAfterReceiver = await pxCvx.balanceOf(receiver);
      const pxCvxAfterDistributor = await pxCvx.balanceOf(distributor);

      expect(totalAssetsBefore).to.not.equal(totalAssetsAfter);
      expect(totalAssetsAfter).to.equal(totalAssetsBefore.sub(expectedAssets));
      expect(totalSupplyBefore).to.not.equal(totalSupplyAfter);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore.sub(sharesBefore));
      expect(pxCvxBeforeReceiver).to.not.equal(pxCvxAfterReceiver);
      expect(pxCvxAfterReceiver).to.equal(
        pxCvxBeforeReceiver.add(expectedAssets)
      );
      expect(pxCvxBeforeDistributor).to.not.equal(pxCvxAfterDistributor);
      expect(pxCvxAfterDistributor).to.equal(
        pxCvxBeforeDistributor.add(feeAmount)
      );
      expect(sharesBefore).to.not.equal(sharesAfter);
      expect(sharesAfter).to.equal(0);

      validateEvent(rewardTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirexStrategy.address,
        to: unionPirex.address,
        amount: rewards,
      });

      validateEvent(getRewardEvent, 'RewardPaid(uint256)', {
        reward: rewards,
      });

      validateEvent(harvestEvent, 'Harvest(address,uint256)', {
        caller: owner,
        value: rewards,
      });

      validateEvent(feeTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: owner,
        amount: feeAmount,
      });

      validateEvent(stakeTransferEvent, 'Transfer(address,address,uint256)', {
        from: unionPirex.address,
        to: unionPirexStrategy.address,
        amount: rewards.sub(feeAmount),
      });

      validateEvent(
        withdrawEvent,
        'Withdraw(address,address,address,uint256,uint256)',
        {
          caller: admin.address,
          receiver,
          owner,
          assets: expectedAssets,
          shares: sharesBefore,
        }
      );

      validateEvent(stakedEvent, 'Staked(uint256)', {
        amount: rewards.sub(feeAmount),
      });
    });
  });

  describe('UnionPirexStrategy: redeemRewards', function () {
    before(async function () {
      const cvxRewardDistribution = [
        {
          account: pirexCvx.address,
          amount: toBN(2e18),
        },
      ];
      const crvRewardDistribution = [
        {
          account: pirexCvx.address,
          amount: toBN(2e18),
        },
      ];
      const cvxTree = new BalanceTree(cvxRewardDistribution);
      const crvTree = new BalanceTree(crvRewardDistribution);

      await cvx.transfer(votiumMultiMerkleStash.address, toBN(2e18));
      await crv.transfer(votiumMultiMerkleStash.address, toBN(2e18));
      await votiumMultiMerkleStash.updateMerkleRoot(
        cvx.address,
        cvxTree.getHexRoot()
      );
      await votiumMultiMerkleStash.updateMerkleRoot(
        crv.address,
        crvTree.getHexRoot()
      );

      const tokens = [cvx.address, crv.address];
      const indexes = [0, 0];
      const amounts = [
        cvxRewardDistribution[0].amount,
        crvRewardDistribution[0].amount,
      ];
      const proofs = [
        cvxTree.getProof(
          indexes[0],
          pirexCvx.address,
          cvxRewardDistribution[0].amount
        ),
        crvTree.getProof(
          indexes[1],
          pirexCvx.address,
          crvRewardDistribution[0].amount
        ),
      ];
      const votiumRewards: any[] = [
        [tokens[0], indexes[0], amounts[0], proofs[0]],
        [tokens[1], indexes[1], amounts[1], proofs[1]],
      ];

      await pirexCvx.claimVotiumRewards(votiumRewards);
    });

    it('Should redeem rewards', async function () {
      const currentEpoch = await pirexCvx.getCurrentEpoch();
      const { snapshotId, snapshotRewards } = await pxCvx.getEpoch(
        currentEpoch
      );
      const distributor = await unionPirexStrategy.distributor();
      const cvxBalanceBefore = await cvx.balanceOf(distributor);
      const crvBalanceBefore = await crv.balanceOf(distributor);
      const rewardIndexes = [0, 1];
      const pxCvxBalanceAtSnapshot = await pxCvx.balanceOfAt(
        unionPirexStrategy.address,
        snapshotId
      );
      const pxCvxSupplyAtSnapshot = await pxCvx.totalSupplyAt(snapshotId);
      const cvxSnapshotRewards = snapshotRewards[0];
      const crvSnapshotRewards = snapshotRewards[1];
      const expectedCvxRewards = cvxSnapshotRewards
        .mul(pxCvxBalanceAtSnapshot)
        .div(pxCvxSupplyAtSnapshot);
      const expectedCrvRewards = crvSnapshotRewards
        .mul(pxCvxBalanceAtSnapshot)
        .div(pxCvxSupplyAtSnapshot);
      const events = await callAndReturnEvents(
        unionPirexStrategy.redeemRewards,
        [currentEpoch, rewardIndexes]
      );
      const redeemEvent = parseLog(pirexCvx, events[0]);
      const cvxTransferEvent = parseLog(cvx, events[1]);
      const crvTransferEvent = parseLog(crv, events[2]);
      const cvxBalanceAfter = await cvx.balanceOf(admin.address);
      const crvBalanceAfter = await crv.balanceOf(admin.address);

      expect(cvxBalanceAfter).to.not.equal(cvxBalanceBefore);
      expect(cvxBalanceAfter).to.equal(
        cvxBalanceBefore.add(expectedCvxRewards)
      );
      expect(crvBalanceAfter).to.not.equal(crvBalanceBefore);
      expect(crvBalanceAfter).to.equal(
        crvBalanceBefore.add(expectedCrvRewards)
      );

      validateEvent(
        redeemEvent,
        'RedeemSnapshotRewards(uint256,uint256[],address,uint256,uint256)',
        {
          epoch: currentEpoch,
          rewardIndexes: rewardIndexes.map((i) => toBN(i)),
          receiver: distributor,
          snapshotBalance: pxCvxBalanceAtSnapshot,
          snapshotSupply: pxCvxSupplyAtSnapshot,
        }
      );

      validateEvent(cvxTransferEvent, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: distributor,
        value: expectedCvxRewards,
      });

      validateEvent(crvTransferEvent, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: distributor,
        value: expectedCrvRewards,
      });
    });
  });

  describe('UnionPirexStrategy: totalSupply', function () {
    it('Should equal the result of the vault totalAssets', async function () {
      const totalSupply = await unionPirexStrategy.totalSupply();
      const totalAssets = await unionPirex.totalAssets();

      expect(totalSupply).to.equal(totalAssets);
    });
  });

  describe('UnionPirexStrategy: stake', function () {
    it('Should revert if not called by vault', async function () {
      const vault = unionPirexStrategy.vault();
      const amount = 1;

      expect(admin.address).to.not.equal(vault);
      await expect(unionPirexStrategy.stake(amount)).to.be.revertedWith(
        'Vault only'
      );
    });
  });

  describe('UnionPirexStrategy: withdraw', function () {
    it('Should revert if not called by vault', async function () {
      const vault = unionPirexStrategy.vault();
      const amount = 1;

      expect(admin.address).to.not.equal(vault);
      await expect(unionPirexStrategy.withdraw(amount)).to.be.revertedWith(
        'Vault only'
      );
    });
  });
});
