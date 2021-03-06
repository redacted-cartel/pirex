import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber } from 'ethers';
import {
  callAndReturnEvents,
  toBN,
  increaseBlockTimestamp,
  validateEvent,
  parseLog,
} from './helpers';
import {
  ConvexToken,
  CvxLockerV2,
  PirexCvx,
  MultiMerkleStash,
  Crv,
  PirexFees,
  PxCvx,
} from '../typechain-types';
import { BalanceTree } from '../lib/merkle';

// Tests the rewards related logic
describe('PirexCvx-Reward', function () {
  let admin: SignerWithAddress;
  let notAdmin: SignerWithAddress;
  let treasury: SignerWithAddress;
  let contributors: SignerWithAddress;
  let pxCvx: PxCvx;
  let pirexCvx: PirexCvx;
  let pirexFees: PirexFees;
  let cvx: ConvexToken;
  let crv: Crv;
  let cvxCrvToken: any;
  let cvxLocker: CvxLockerV2;
  let votiumMultiMerkleStash: MultiMerkleStash;

  let zeroAddress: string;
  let feeDenominator: number;
  let feePercentDenominator: number;
  let epochDuration: BigNumber;

  let futuresEnum: any;
  let feesEnum: any;
  let snapshotRedeemEpoch: BigNumber;

  before(async function () {
    ({
      admin,
      notAdmin,
      treasury,
      contributors,
      cvx,
      crv,
      cvxCrvToken,
      cvxLocker,
      votiumMultiMerkleStash,
      pirexFees,
      pxCvx,
      pirexCvx,
      feePercentDenominator,
      feeDenominator,
      zeroAddress,
      epochDuration,
      futuresEnum,
      feesEnum,
    } = this);
  });

  describe('claimVotiumRewards', function () {
    let cvxRewardDistribution: { account: string; amount: BigNumber }[];
    let crvRewardDistribution: { account: string; amount: BigNumber }[];
    let cvxTree: BalanceTree;
    let crvTree: BalanceTree;

    before(async function () {
      await pxCvx.takeEpochSnapshot();

      // Provision rpxCVX tokens for futures redemption later
      const assets = toBN(5e17);

      await pxCvx.approve(pirexCvx.address, assets);
      await pirexCvx.stake(255, futuresEnum.reward, assets, admin.address);

      cvxRewardDistribution = [
        {
          account: pirexCvx.address,
          amount: toBN(1e18),
        },
      ];
      crvRewardDistribution = [
        {
          account: pirexCvx.address,
          amount: toBN(2e18),
        },
      ];
      cvxTree = new BalanceTree(cvxRewardDistribution);
      crvTree = new BalanceTree(crvRewardDistribution);

      const token1 = cvx.address;
      const token2 = crv.address;

      await cvx.transfer(votiumMultiMerkleStash.address, toBN(1e18));
      await votiumMultiMerkleStash.updateMerkleRoot(
        token1,
        cvxTree.getHexRoot()
      );

      await crv.transfer(votiumMultiMerkleStash.address, toBN(2e18));
      await votiumMultiMerkleStash.updateMerkleRoot(
        token2,
        crvTree.getHexRoot()
      );
    });

    it('Should revert if votiumRewards.length is zero', async function () {
      const votiumRewards: any[] = [];

      await expect(pirexCvx.claimVotiumRewards(votiumRewards)).to.be.revertedWith(
        'EmptyArray()'
      );
    });

    it('Should claim Votium rewards', async function () {
      const tokens: any = [cvx.address, crv.address];
      const indexes: any = [0, 0];
      const amounts: any = [
        cvxRewardDistribution[0].amount,
        crvRewardDistribution[0].amount,
      ];
      const merkleProofs: any = [
        cvxTree.getProof(indexes[0], pirexCvx.address, amounts[0]),
        crvTree.getProof(indexes[1], pirexCvx.address, amounts[1]),
      ];
      const votiumRewards: any[] = [
        [tokens[0], indexes[0], amounts[0], merkleProofs[0]],
        [tokens[1], indexes[1], amounts[1], merkleProofs[1]],
      ];

      snapshotRedeemEpoch = await pirexCvx.getCurrentEpoch();
      const currentEpoch = snapshotRedeemEpoch;
      const epochRpxCvxSupply = await (
        await this.getRpxCvx(await pirexCvx.rpxCvx())
      ).totalSupply(currentEpoch);
      const rewardFee = await pirexCvx.fees(feesEnum.reward);
      const cvxFee = amounts[0].mul(rewardFee).div(feeDenominator);
      const crvFee = amounts[1].mul(rewardFee).div(feeDenominator);
      const treasuryCvxBalanceBefore = await cvx.balanceOf(treasury.address);
      const contributorsCvxBalanceBefore = await cvx.balanceOf(
        contributors.address
      );
      const treasuryCrvBalanceBefore = await crv.balanceOf(treasury.address);
      const contributorsCrvBalanceBefore = await crv.balanceOf(
        contributors.address
      );
      const events = await callAndReturnEvents(pirexCvx.claimVotiumRewards, [
        votiumRewards,
      ]);
      const cvxVotiumRewardClaimEvent = events[0];
      const votiumToPirexCvxTransferEvent = parseLog(pxCvx, events[1]);
      const cvxFeeTreasuryDistributionEvent = parseLog(pxCvx, events[5]);
      const cvxFeeContributorsDistributionEvent = parseLog(pxCvx, events[7]);
      const crvVotiumRewardClaimEvent = events[9];
      const votiumToPirexCrvTransfer = parseLog(pxCvx, events[10]);
      const crvFeeTreasuryDistributionEvent = parseLog(pxCvx, events[15]);
      const crvFeeContributorsDistributionEvent = parseLog(
        pxCvx,
        events[events.length - 1]
      );
      const votium = await pirexCvx.votiumMultiMerkleStash();
      const { snapshotId, rewards, snapshotRewards, futuresRewards } =
        await pxCvx.getEpoch(currentEpoch);
      const snapshotSupply = await pxCvx.totalSupplyAt(snapshotId);
      const votiumSnapshotRewards = snapshotRewards;
      const votiumFuturesRewards = futuresRewards;
      const expectedVotiumSnapshotRewards = {
        amounts: amounts.map((amount: BigNumber) => {
          const feeAmount = amount.mul(rewardFee).div(feeDenominator);

          return amount
            .sub(feeAmount)
            .mul(snapshotSupply)
            .div(snapshotSupply.add(epochRpxCvxSupply));
        }),
      };
      const expectedVotiumFuturesRewards = {
        amounts: amounts.map((amount: BigNumber) => {
          const feeAmount = amount.mul(rewardFee).div(feeDenominator);
          const snapshotRewards = amount
            .sub(feeAmount)
            .mul(snapshotSupply)
            .div(snapshotSupply.add(epochRpxCvxSupply));

          return amount.sub(feeAmount).sub(snapshotRewards);
        }),
      };
      const treasuryCvxBalanceAfter = await cvx.balanceOf(treasury.address);
      const contributorsCvxBalanceAfter = await cvx.balanceOf(
        contributors.address
      );
      const treasuryCrvBalanceAfter = await crv.balanceOf(treasury.address);
      const contributorsCrvBalanceAfter = await crv.balanceOf(
        contributors.address
      );
      const treasuryCrvReceived = treasuryCrvBalanceAfter.sub(
        treasuryCrvBalanceBefore
      );
      const treasuryCvxReceived = treasuryCvxBalanceAfter.sub(
        treasuryCvxBalanceBefore
      );
      const contributorsCrvReceived = contributorsCrvBalanceAfter.sub(
        contributorsCrvBalanceBefore
      );
      const contributorsCvxReceived = contributorsCvxBalanceAfter.sub(
        contributorsCvxBalanceBefore
      );
      const treasuryPercent = await pirexFees.treasuryPercent();
      const expectedTreasuryCvxFees = cvxFee
        .mul(treasuryPercent)
        .div(feePercentDenominator);
      const expectedContributorsCvxFees = cvxFee.sub(expectedTreasuryCvxFees);
      const expectedTreasuryCrvFees = crvFee
        .mul(treasuryPercent)
        .div(feePercentDenominator);
      const expectedContributorsCrvFees = crvFee.sub(expectedTreasuryCrvFees);
      const parsedRewards = rewards.map((r) => r.slice(0, 42));

      expect(parsedRewards.includes(tokens[0].toLowerCase())).to.equal(true);
      expect(parsedRewards.includes(tokens[1].toLowerCase())).to.equal(true);
      expect(votiumSnapshotRewards).to.deep.equal(
        expectedVotiumSnapshotRewards.amounts
      );
      expect(votiumFuturesRewards).to.deep.equal(
        expectedVotiumFuturesRewards.amounts
      );
      expect(treasuryCvxBalanceAfter).to.not.equal(treasuryCvxBalanceBefore);
      expect(treasuryCvxBalanceAfter).to.equal(
        treasuryCvxBalanceBefore.add(expectedTreasuryCvxFees)
      );
      expect(contributorsCvxBalanceAfter).to.not.equal(
        contributorsCvxBalanceBefore
      );
      expect(contributorsCvxBalanceAfter).to.equal(
        contributorsCvxBalanceBefore.add(expectedContributorsCvxFees)
      );
      expect(treasuryCrvBalanceAfter).to.not.equal(treasuryCrvBalanceBefore);
      expect(treasuryCrvBalanceAfter).to.equal(
        treasuryCrvBalanceBefore.add(expectedTreasuryCrvFees)
      );
      expect(contributorsCrvBalanceAfter).to.not.equal(
        contributorsCrvBalanceBefore
      );
      expect(contributorsCrvBalanceAfter).to.equal(
        contributorsCrvBalanceBefore.add(expectedContributorsCrvFees)
      );
      expect(cvxFee).to.equal(treasuryCvxReceived.add(contributorsCvxReceived));
      expect(crvFee).to.equal(treasuryCrvReceived.add(contributorsCrvReceived));
      expect(treasuryCrvReceived).to.equal(expectedTreasuryCrvFees);
      expect(treasuryCvxReceived).to.equal(expectedTreasuryCvxFees);
      expect(contributorsCrvReceived).to.equal(expectedContributorsCrvFees);
      expect(contributorsCvxReceived).to.equal(expectedContributorsCvxFees);

      validateEvent(
        cvxVotiumRewardClaimEvent,
        'ClaimVotiumReward(address,uint256,uint256)',
        {
          token: tokens[0],
          index: indexes[0],
          amount: amounts[0],
        }
      );
      validateEvent(
        crvVotiumRewardClaimEvent,
        'ClaimVotiumReward(address,uint256,uint256)',
        {
          token: tokens[1],
          index: indexes[1],
          amount: amounts[1],
        }
      );
      validateEvent(
        votiumToPirexCvxTransferEvent,
        'Transfer(address,address,uint256)',
        {
          from: votium,
          to: pirexCvx.address,
          amount: amounts[0],
        }
      );
      validateEvent(
        cvxFeeTreasuryDistributionEvent,
        'Transfer(address,address,uint256)',
        {
          from: pirexCvx.address,
          to: treasury.address,
          amount: treasuryCvxBalanceAfter.sub(treasuryCvxBalanceBefore),
        }
      );
      validateEvent(
        cvxFeeContributorsDistributionEvent,
        'Transfer(address,address,uint256)',
        {
          from: pirexCvx.address,
          to: contributors.address,
          amount: contributorsCvxBalanceAfter.sub(contributorsCvxBalanceBefore),
        }
      );
      validateEvent(
        votiumToPirexCrvTransfer,
        'Transfer(address,address,uint256)',
        {
          from: votium,
          to: pirexCvx.address,
          amount: amounts[1],
        }
      );
      validateEvent(
        crvFeeTreasuryDistributionEvent,
        'Transfer(address,address,uint256)',
        {
          from: pirexCvx.address,
          to: treasury.address,
          amount: treasuryCrvBalanceAfter.sub(treasuryCrvBalanceBefore),
        }
      );
      validateEvent(
        crvFeeContributorsDistributionEvent,
        'Transfer(address,address,uint256)',
        {
          from: pirexCvx.address,
          to: contributors.address,
          amount: contributorsCrvBalanceAfter.sub(contributorsCrvBalanceBefore),
        }
      );
    });
  });

  describe('claimMiscRewards', function () {
    before(async function () {
      const crvRewardAmount = toBN(5e18);
      const cvxCrvRewardAmount = toBN(10e18);

      await crv.approve(cvxLocker.address, crvRewardAmount);
      await cvxCrvToken.approve(cvxLocker.address, cvxCrvRewardAmount);
      await cvxLocker.notifyRewardAmount(crv.address, crvRewardAmount);
      await cvxLocker.notifyRewardAmount(
        cvxCrvToken.address,
        cvxCrvRewardAmount
      );

      // Increase time to accrue rewards
      await increaseBlockTimestamp(1000);
    });

    it('Should claim misc rewards for the epoch', async function () {
      const treasuryCrvBalanceBefore = await crv.balanceOf(treasury.address);
      const contributorsCrvBalanceBefore = await crv.balanceOf(
        contributors.address
      );
      const treasuryCvxCrvBalanceBefore = await cvxCrvToken.balanceOf(
        treasury.address
      );
      const contributorsCvxCrvBalanceBefore = await cvxCrvToken.balanceOf(
        contributors.address
      );
      const [claimableCrv, claimableCvxCrv] = await cvxLocker.claimableRewards(
        pirexCvx.address
      );
      const crvBalanceBefore = await crv.balanceOf(pirexCvx.address);
      const cvxCrvBalanceBefore = await cvxCrvToken.balanceOf(pirexCvx.address);
      const events = await callAndReturnEvents(pirexCvx.claimMiscRewards, []);
      const claimEvent = events[0];
      const treasuryCrvBalanceAfter = await crv.balanceOf(treasury.address);
      const contributorsCrvBalanceAfter = await crv.balanceOf(
        contributors.address
      );
      const treasuryCvxCrvBalanceAfter = await cvxCrvToken.balanceOf(
        treasury.address
      );
      const contributorsCvxCrvBalanceAfter = await cvxCrvToken.balanceOf(
        contributors.address
      );
      const treasuryPercent = await pirexFees.treasuryPercent();
      const contributorsPercent = feePercentDenominator - treasuryPercent;
      const expectedTreasuryCrvFees = claimableCrv.amount
        .mul(treasuryPercent)
        .div(feePercentDenominator);
      const expectedContributorsCrvFees = claimableCrv.amount
        .mul(contributorsPercent)
        .div(feePercentDenominator);
      const expectedTreasuryCvxCrvFees = claimableCvxCrv.amount
        .mul(treasuryPercent)
        .div(feePercentDenominator);
      const expectedContributorsCvxCrvFees = claimableCvxCrv.amount
        .mul(contributorsPercent)
        .div(feePercentDenominator);
      const crvBalanceAfter = await crv.balanceOf(pirexCvx.address);
      const cvxCrvBalanceAfter = await cvxCrvToken.balanceOf(pirexCvx.address);

      expect(treasuryCrvBalanceAfter).to.not.equal(treasuryCrvBalanceBefore);
      expect(
        treasuryCrvBalanceAfter.gt(
          treasuryCrvBalanceBefore.add(expectedTreasuryCrvFees)
        )
      ).to.equal(true);
      expect(
        treasuryCrvBalanceAfter.lt(
          treasuryCrvBalanceBefore
            .add(expectedTreasuryCrvFees)
            .mul(101)
            .div(100)
        )
      ).to.equal(true);
      expect(contributorsCrvBalanceAfter).to.not.equal(
        contributorsCrvBalanceBefore
      );
      expect(
        contributorsCrvBalanceAfter.gt(
          contributorsCrvBalanceBefore.add(expectedContributorsCrvFees)
        )
      ).to.equal(true);
      expect(
        contributorsCrvBalanceAfter.lt(
          contributorsCrvBalanceBefore
            .add(expectedContributorsCrvFees)
            .mul(101)
            .div(100)
        )
      ).to.equal(true);
      expect(treasuryCvxCrvBalanceAfter).to.not.equal(
        treasuryCvxCrvBalanceBefore
      );
      expect(
        treasuryCvxCrvBalanceAfter.gt(
          treasuryCvxCrvBalanceBefore.add(expectedTreasuryCvxCrvFees)
        )
      ).to.equal(true);
      expect(
        treasuryCvxCrvBalanceAfter.lt(
          treasuryCvxCrvBalanceBefore
            .add(expectedTreasuryCvxCrvFees)
            .mul(101)
            .div(100)
        )
      ).to.equal(true);
      expect(contributorsCvxCrvBalanceAfter).to.not.equal(
        contributorsCvxCrvBalanceBefore
      );
      expect(
        contributorsCvxCrvBalanceAfter.gt(
          contributorsCvxCrvBalanceBefore.add(expectedContributorsCvxCrvFees)
        )
      ).to.equal(true);
      expect(
        contributorsCvxCrvBalanceAfter.lt(
          contributorsCvxCrvBalanceBefore
            .add(expectedContributorsCvxCrvFees)
            .mul(101)
            .div(100)
        )
      ).to.equal(true);

      // All misc rewards need to be distributed to stakeholders, no remainder
      expect(crvBalanceAfter).to.equal(crvBalanceBefore);
      expect(cvxCrvBalanceAfter).to.equal(cvxCrvBalanceBefore);

      validateEvent(
        claimEvent,
        'ClaimMiscRewards(uint256,(address,uint256,uint256)[])',
        {}
      );
    });
  });

  describe('redeemSnapshotRewards', function () {
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

    it('Should revert if rewardIndexes is an empty array', async function () {
      const epoch = snapshotRedeemEpoch;
      const invalidRewardIndexes: any = [];
      const receiver = admin.address;

      await expect(
        pirexCvx.redeemSnapshotRewards(epoch, invalidRewardIndexes, receiver)
      ).to.be.revertedWith('EmptyArray()');
    });

    it('Should redeem a single snapshot reward', async function () {
      const cvxBalanceBefore = await cvx.balanceOf(admin.address);
      const currentEpoch = snapshotRedeemEpoch;
      const { snapshotId, snapshotRewards } = await pxCvx.getEpoch(
        currentEpoch
      );
      const snapshotBalance = await pxCvx.balanceOfAt(
        admin.address,
        snapshotId
      );
      const snapshotSupply = await pxCvx.totalSupplyAt(snapshotId);
      const rewardIndexes = [0];
      const receiver = admin.address;
      const [redeemEvent] = await callAndReturnEvents(
        pirexCvx.redeemSnapshotRewards,
        [currentEpoch, rewardIndexes, receiver]
      );
      const cvxBalanceAfter = await cvx.balanceOf(admin.address);
      const expectedCvxRewards = snapshotRewards[rewardIndexes[0]]
        .mul(snapshotBalance)
        .div(snapshotSupply);

      expect(cvxBalanceAfter).to.not.equal(cvxBalanceBefore);
      expect(cvxBalanceAfter).to.equal(
        cvxBalanceBefore.add(expectedCvxRewards)
      );
      validateEvent(
        redeemEvent,
        'RedeemSnapshotRewards(uint256,uint256[],address,uint256,uint256)',
        {
          epoch: currentEpoch,
          rewardIndexes: rewardIndexes.map((b) => toBN(b)),
          receiver,
          snapshotBalance,
          snapshotSupply,
        }
      );
    });

    it('Should redeem multiple snapshot rewards', async function () {
      const epoch = snapshotRedeemEpoch;
      const rewardIndexes = [1, 2, 3];
      const receiver = admin.address;
      const cvxBalanceBefore = await cvx.balanceOf(admin.address);
      const crvBalanceBefore = await crv.balanceOf(admin.address);
      const events = await callAndReturnEvents(pirexCvx.redeemSnapshotRewards, [
        epoch,
        rewardIndexes,
        receiver,
      ]);
      const redeemEvent = events[0];
      const transferEvent1 = parseLog(pxCvx, events[1]);
      const transferEvent2 = parseLog(pxCvx, events[2]);
      const transferEvent3 = parseLog(pxCvx, events[3]);
      const cvxBalanceAfter = await cvx.balanceOf(admin.address);
      const crvBalanceAfter = await crv.balanceOf(admin.address);
      const { snapshotId, snapshotRewards } = await pxCvx.getEpoch(
        snapshotRedeemEpoch
      );
      const snapshotBalance = await pxCvx.balanceOfAt(
        admin.address,
        snapshotId
      );
      const snapshotSupply = await pxCvx.totalSupplyAt(snapshotId);
      const expectedSnapshotCrvRewards = [
        snapshotRewards[rewardIndexes[0]]
          .mul(snapshotBalance)
          .div(snapshotSupply),
        snapshotRewards[rewardIndexes[2]]
          .mul(snapshotBalance)
          .div(snapshotSupply),
      ];
      const expectedSnapshotCvxRewards = snapshotRewards[rewardIndexes[1]]
        .mul(snapshotBalance)
        .div(snapshotSupply);
      const totalExpectedSnapshotCrvRewards = expectedSnapshotCrvRewards.reduce(
        (acc, val) => acc.add(val),
        toBN(0)
      );

      expect(cvxBalanceAfter).to.equal(
        cvxBalanceBefore.add(expectedSnapshotCvxRewards)
      );
      expect(crvBalanceAfter).to.equal(
        crvBalanceBefore.add(totalExpectedSnapshotCrvRewards)
      );
      validateEvent(
        redeemEvent,
        'RedeemSnapshotRewards(uint256,uint256[],address,uint256,uint256)',
        {
          epoch,
          rewardIndexes: rewardIndexes.map((b) => toBN(b)),
          receiver,
          snapshotBalance,
          snapshotSupply,
        }
      );
      validateEvent(transferEvent1, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: receiver,
        amount: expectedSnapshotCrvRewards[0],
      });
      validateEvent(transferEvent2, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: receiver,
        amount: expectedSnapshotCvxRewards,
      });
      validateEvent(transferEvent3, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: receiver,
        amount: expectedSnapshotCrvRewards[1],
      });
    });

    it('Should revert if msg.sender has already redeemed', async function () {
      const epoch = snapshotRedeemEpoch;
      const rewardIndexes = [2];
      const receiver = admin.address;

      await expect(
        pirexCvx.redeemSnapshotRewards(epoch, rewardIndexes, receiver)
      ).to.be.revertedWith('AlreadyRedeemed()');
    });
  });

  describe('redeemFuturesRewards', function () {
    it('Should revert if epoch is zero', async function () {
      const invalidEpoch = 0;
      const receiver = admin.address;

      await expect(
        pirexCvx.redeemFuturesRewards(invalidEpoch, receiver)
      ).to.be.revertedWith('InvalidEpoch()');
    });

    it('Should revert if epoch is greater than the current epoch', async function () {
      const invalidEpoch = snapshotRedeemEpoch.add(1);
      const receiver = admin.address;

      await expect(
        pirexCvx.redeemFuturesRewards(invalidEpoch, receiver)
      ).to.be.revertedWith('InvalidEpoch()');
    });

    it('Should revert if receiver is zero address', async function () {
      const epoch = snapshotRedeemEpoch;
      const invalidReceiver = zeroAddress;
      const rpxCvx = await this.getRpxCvx(await pirexCvx.rpxCvx());

      await rpxCvx.setApprovalForAll(pirexCvx.address, true);

      await expect(
        pirexCvx.redeemFuturesRewards(epoch, invalidReceiver)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if sender has an insufficient balance', async function () {
      const epoch = snapshotRedeemEpoch;
      const to = admin.address;

      await expect(
        pirexCvx.connect(notAdmin).redeemFuturesRewards(epoch, to)
      ).to.be.revertedWith('InsufficientBalance()');
    });

    it('should revert if the contract is paused', async function () {
      const epoch = snapshotRedeemEpoch;
      const to = admin.address;

      await pirexCvx.setPauseState(true);

      await expect(pirexCvx.redeemFuturesRewards(epoch, to)).to.be.revertedWith(
        'Pausable: paused'
      );

      await pirexCvx.setPauseState(false);
    });

    it('Should redeem futures reward', async function () {
      const cvxBalanceBefore = await cvx.balanceOf(admin.address);
      const crvBalanceBefore = await crv.balanceOf(admin.address);
      const epoch = snapshotRedeemEpoch;
      const receiver = admin.address;
      const rpxCvx = await this.getRpxCvx(await pirexCvx.rpxCvx());
      const { rewards, futuresRewards } = await pxCvx.getEpoch(epoch);

      // Transfer half to test correctness for partial reward redemptions
      await rpxCvx.safeTransferFrom(
        admin.address,
        notAdmin.address,
        epoch,
        (await rpxCvx.balanceOf(admin.address, epoch)).div(2),
        ethers.utils.formatBytes32String('')
      );

      const rpxCvxBalanceBefore = await rpxCvx.balanceOf(admin.address, epoch);
      const rpxCvxSupplyBefore = await rpxCvx.totalSupply(epoch);

      await rpxCvx.setApprovalForAll(pirexCvx.address, true);

      const events = await callAndReturnEvents(pirexCvx.redeemFuturesRewards, [
        epoch,
        receiver,
      ]);
      const redeemEvent = events[0];
      const burnEvent = parseLog(rpxCvx, events[1]);
      const rewardTransferEvent1 = parseLog(cvx, events[2]);
      const rewardTransferEvent2 = parseLog(crv, events[3]);
      const rewardTransferEvent3 = parseLog(cvx, events[4]);
      const rewardTransferEvent4 = parseLog(crv, events[5]);
      const updateRewardsEvent = parseLog(pxCvx, events[6]);
      const cvxBalanceAfter = await cvx.balanceOf(admin.address);
      const crvBalanceAfter = await crv.balanceOf(admin.address);
      const rpxCvxBalanceAfter = await rpxCvx.balanceOf(admin.address, epoch);
      const rpxCvxSupplyAfter = await rpxCvx.totalSupply(epoch);
      const { futuresRewards: updatedFuturesRewards } = await pxCvx.getEpoch(
        epoch
      );
      const expectedClaimAmounts = futuresRewards.map((amount: BigNumber) =>
        amount.mul(rpxCvxBalanceBefore).div(rpxCvxSupplyBefore)
      );
      const totalExpectedCvxClaimAmounts = expectedClaimAmounts[0].add(
        expectedClaimAmounts[2]
      );
      const totalExpectedCrvClaimAmounts = expectedClaimAmounts[1].add(
        expectedClaimAmounts[3]
      );

      expect(rpxCvxBalanceAfter).to.not.equal(rpxCvxBalanceBefore);
      expect(rpxCvxBalanceAfter).to.equal(0);
      expect(rpxCvxSupplyAfter).to.not.equal(rpxCvxSupplyBefore);
      expect(rpxCvxSupplyAfter).to.equal(
        rpxCvxSupplyBefore.sub(rpxCvxBalanceBefore)
      );
      expect(cvxBalanceAfter).to.not.equal(cvxBalanceBefore);
      expect(cvxBalanceAfter).to.equal(
        cvxBalanceBefore.add(totalExpectedCvxClaimAmounts)
      );
      expect(crvBalanceAfter).to.not.equal(crvBalanceBefore);
      expect(crvBalanceAfter).to.equal(
        crvBalanceBefore.add(totalExpectedCrvClaimAmounts)
      );
      expect(futuresRewards[0].sub(expectedClaimAmounts[0])).to.equal(
        updatedFuturesRewards[0]
      );
      expect(futuresRewards[1].sub(expectedClaimAmounts[1])).to.equal(
        updatedFuturesRewards[1]
      );
      expect(futuresRewards[2].sub(expectedClaimAmounts[2])).to.equal(
        updatedFuturesRewards[2]
      );
      expect(futuresRewards[3].sub(expectedClaimAmounts[3])).to.equal(
        updatedFuturesRewards[3]
      );

      validateEvent(
        redeemEvent,
        'RedeemFuturesRewards(uint256,address,bytes32[])',
        {
          epoch,
          receiver,
          rewards,
        }
      );

      validateEvent(
        burnEvent,
        'TransferSingle(address,address,address,uint256,uint256)',
        {
          operator: pirexCvx.address,
          from: admin.address,
          to: zeroAddress,
          id: epoch,
          value: rpxCvxBalanceBefore,
        }
      );

      validateEvent(rewardTransferEvent1, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: admin.address,
        value: expectedClaimAmounts[0],
      });

      validateEvent(rewardTransferEvent2, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: admin.address,
        value: expectedClaimAmounts[1],
      });

      validateEvent(rewardTransferEvent3, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: admin.address,
        value: expectedClaimAmounts[2],
      });

      validateEvent(rewardTransferEvent4, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: admin.address,
        value: expectedClaimAmounts[3],
      });

      validateEvent(
        updateRewardsEvent,
        'UpdateEpochFuturesRewards(uint256,uint256[])',
        {
          epoch,
          futuresRewards: updatedFuturesRewards,
        }
      );
    });

    it('Should redeem the remaining futures rewards', async function () {
      const cvxBalanceBefore = await cvx.balanceOf(notAdmin.address);
      const crvBalanceBefore = await crv.balanceOf(notAdmin.address);
      const epoch = snapshotRedeemEpoch;
      const receiver = notAdmin.address;
      const rpxCvx = await this.getRpxCvx(await pirexCvx.rpxCvx());
      const { rewards, futuresRewards } = await pxCvx.getEpoch(epoch);
      const rpxCvxBalanceBefore = await rpxCvx.balanceOf(notAdmin.address, epoch);
      const rpxCvxSupplyBefore = await rpxCvx.totalSupply(epoch);

      await rpxCvx.connect(notAdmin).setApprovalForAll(pirexCvx.address, true);

      const events = await callAndReturnEvents(
        pirexCvx.connect(notAdmin).redeemFuturesRewards,
        [epoch, receiver]
      );

      const redeemEvent = events[0];
      const burnEvent = parseLog(rpxCvx, events[1]);
      const rewardTransferEvent1 = parseLog(cvx, events[2]);
      const rewardTransferEvent2 = parseLog(crv, events[3]);
      const rewardTransferEvent3 = parseLog(cvx, events[4]);
      const rewardTransferEvent4 = parseLog(crv, events[5]);
      const updateRewardsEvent = parseLog(pxCvx, events[6]);
      const cvxBalanceAfter = await cvx.balanceOf(notAdmin.address);
      const crvBalanceAfter = await crv.balanceOf(notAdmin.address);
      const rpxCvxBalanceAfter = await rpxCvx.balanceOf(notAdmin.address, epoch);
      const rpxCvxSupplyAfter = await rpxCvx.totalSupply(epoch);
      const { futuresRewards: updatedFuturesRewards } = await pxCvx.getEpoch(
        epoch
      );
      const expectedClaimAmounts = futuresRewards.map((amount: BigNumber) =>
        amount.mul(rpxCvxBalanceBefore).div(rpxCvxSupplyBefore)
      );
      const totalExpectedCvxClaimAmounts = expectedClaimAmounts[0].add(
        expectedClaimAmounts[2]
      );
      const totalExpectedCrvClaimAmounts = expectedClaimAmounts[1].add(
        expectedClaimAmounts[3]
      );

      expect(rpxCvxBalanceAfter).to.not.equal(rpxCvxBalanceBefore);
      expect(rpxCvxBalanceAfter).to.equal(0);
      expect(rpxCvxSupplyAfter).to.not.equal(rpxCvxSupplyBefore);
      expect(rpxCvxSupplyAfter).to.equal(
        rpxCvxSupplyBefore.sub(rpxCvxBalanceBefore)
      );
      expect(cvxBalanceAfter).to.not.equal(cvxBalanceBefore);
      expect(cvxBalanceAfter).to.equal(
        cvxBalanceBefore.add(totalExpectedCvxClaimAmounts)
      );
      expect(crvBalanceAfter).to.not.equal(crvBalanceBefore);
      expect(crvBalanceAfter).to.equal(
        crvBalanceBefore.add(totalExpectedCrvClaimAmounts)
      );
      expect(futuresRewards[0].sub(expectedClaimAmounts[0])).to.equal(
        updatedFuturesRewards[0]
      );
      expect(futuresRewards[1].sub(expectedClaimAmounts[1])).to.equal(
        updatedFuturesRewards[1]
      );
      expect(futuresRewards[2].sub(expectedClaimAmounts[2])).to.equal(
        updatedFuturesRewards[2]
      );
      expect(futuresRewards[3].sub(expectedClaimAmounts[3])).to.equal(
        updatedFuturesRewards[3]
      );

      validateEvent(
        redeemEvent,
        'RedeemFuturesRewards(uint256,address,bytes32[])',
        {
          epoch,
          receiver,
          rewards,
        }
      );

      validateEvent(
        burnEvent,
        'TransferSingle(address,address,address,uint256,uint256)',
        {
          operator: pirexCvx.address,
          from: notAdmin.address,
          to: zeroAddress,
          id: epoch,
          value: rpxCvxBalanceBefore,
        }
      );

      validateEvent(rewardTransferEvent1, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: notAdmin.address,
        value: expectedClaimAmounts[0],
      });

      validateEvent(rewardTransferEvent2, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: notAdmin.address,
        value: expectedClaimAmounts[1],
      });

      validateEvent(rewardTransferEvent3, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: notAdmin.address,
        value: expectedClaimAmounts[2],
      });

      validateEvent(rewardTransferEvent4, 'Transfer(address,address,uint256)', {
        from: pirexCvx.address,
        to: notAdmin.address,
        value: expectedClaimAmounts[3],
      });

      validateEvent(
        updateRewardsEvent,
        'UpdateEpochFuturesRewards(uint256,uint256[])',
        {
          epoch,
          futuresRewards: updatedFuturesRewards,
        }
      );
    });
  });

  describe('exchangeFutures', function () {
    it('Should revert if epoch is current', async function () {
      const invalidEpoch1 = snapshotRedeemEpoch;
      const invalidEpoch2 = invalidEpoch1.sub(epochDuration);
      const amount = toBN(1e18);
      const receiver = admin.address;
      const f = futuresEnum.reward;

      await expect(
        pirexCvx.exchangeFutures(invalidEpoch1, amount, receiver, f)
      ).to.be.revertedWith('PastExchangePeriod()');
      await expect(
        pirexCvx.exchangeFutures(invalidEpoch2, amount, receiver, f)
      ).to.be.revertedWith('PastExchangePeriod()');
    });

    it('Should revert if amount is zero', async function () {
      const epoch = snapshotRedeemEpoch.add(epochDuration);
      const invalidAmount = 0;
      const receiver = admin.address;
      const f = futuresEnum.reward;

      await expect(
        pirexCvx.exchangeFutures(epoch, invalidAmount, receiver, f)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if receiver is zero address', async function () {
      const epoch = snapshotRedeemEpoch.add(epochDuration);
      const amount = toBN(1);
      const invalidReceiver = zeroAddress;
      const f = futuresEnum.reward;

      await expect(
        pirexCvx.exchangeFutures(epoch, amount, invalidReceiver, f)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if sender balance is insufficient', async function () {
      const epoch = snapshotRedeemEpoch.add(epochDuration);
      const rpxCvx = await this.getRpxCvx(await pirexCvx.rpxCvx());
      const sender = notAdmin.address;
      const rpxCvxBalance = await rpxCvx.balanceOf(sender, epoch);
      const amount = toBN(1);
      const receiver = admin.address;
      const f = futuresEnum.reward;

      await rpxCvx.connect(notAdmin).setApprovalForAll(pirexCvx.address, true);

      expect(rpxCvxBalance.lt(amount)).to.equal(true);
      await expect(
        pirexCvx.connect(notAdmin).exchangeFutures(epoch, amount, receiver, f)
      ).to.be.revertedWith('ERC1155: burn amount exceeds balance');
    });

    it('should revert if the contract is paused', async function () {
      const epoch = snapshotRedeemEpoch.add(epochDuration);
      const amount = toBN(1);
      const receiver = admin.address;
      const f = futuresEnum.reward;

      await pirexCvx.setPauseState(true);

      await expect(
        pirexCvx.exchangeFutures(epoch, amount, receiver, f)
      ).to.be.revertedWith('Pausable: paused');

      await pirexCvx.setPauseState(false);
    });

    it('Should exchange rewards futures for vote futures', async function () {
      const epoch = snapshotRedeemEpoch.add(epochDuration);
      const rpxCvx = await this.getRpxCvx(await pirexCvx.rpxCvx());
      const vpxCvx = await this.getVpxCvx(await pirexCvx.vpxCvx());
      const sender = admin.address;
      const receiver = admin.address;
      const rpxCvxBalanceBefore = await rpxCvx.balanceOf(sender, epoch);
      const vpxCvxBalanceBefore = await vpxCvx.balanceOf(receiver, epoch);
      const amount = toBN(1);
      const f = futuresEnum.reward;
      const events = await callAndReturnEvents(pirexCvx.exchangeFutures, [
        epoch,
        amount,
        receiver,
        f,
      ]);
      const exchangeEvent = events[0];
      const rpxCvxBalanceAfter = await rpxCvx.balanceOf(sender, epoch);
      const vpxCvxBalanceAfter = await vpxCvx.balanceOf(receiver, epoch);

      expect(rpxCvxBalanceAfter).to.equal(rpxCvxBalanceBefore.sub(amount));
      expect(vpxCvxBalanceAfter).to.equal(vpxCvxBalanceBefore.add(amount));
      validateEvent(
        exchangeEvent,
        'ExchangeFutures(uint256,uint256,address,uint8)',
        {
          epoch,
          amount,
          receiver,
          f,
        }
      );
    });
  });
});
