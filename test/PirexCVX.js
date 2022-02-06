const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PirexCVX", () => {
  let cvx;
  let cvxLocker;
  let pirexCvx;
  let cvxLockerLockDuration;
  let firstDepositEpoch;
  let secondDepositEpoch;

  const initialCvxBalanceForAdmin = ethers.BigNumber.from(`${10e18}`);
  const epochDepositDuration = 1209600; // 2 weeks in seconds

  before(async () => {
    [admin, notAdmin] = await ethers.getSigners();

    cvx = await (await ethers.getContractFactory("Cvx")).deploy();

    cvxLocker = await (
      await ethers.getContractFactory("CvxLocker")
    ).deploy(cvx.address);

    cvxLockerLockDuration = await cvxLocker.lockDuration();

    pirexCvx = await (
      await ethers.getContractFactory("PirexCVX")
    ).deploy(
      cvxLocker.address,
      cvx.address,
      epochDepositDuration,
      cvxLockerLockDuration
    );

    await cvxLocker.setStakingContract(
      "0xe096ccec4a1d36f191189fe61e803d8b2044dfc3"
    );
    await cvxLocker.setApprovals();

    await cvx.mint(admin.address, initialCvxBalanceForAdmin);
  });

  describe("constructor", () => {
    it("Should set up contract state", async () => {
      const owner = await pirexCvx.owner();
      const _cvxLocker = await pirexCvx.cvxLocker();
      const _cvx = await pirexCvx.cvx();
      const _epochDepositDuration = await pirexCvx.epochDepositDuration();
      const _lockDuration = await pirexCvx.lockDuration();
      const erc20Implementation = await pirexCvx.erc20Implementation();

      expect(owner).to.equal(admin.address);
      expect(_cvxLocker).to.equal(cvxLocker.address);
      expect(_cvx).to.equal(cvx.address);
      expect(_epochDepositDuration).to.equal(epochDepositDuration);
      expect(_lockDuration).to.equal(cvxLockerLockDuration);
      expect(erc20Implementation).to.not.equal(
        "0x0000000000000000000000000000000000000000"
      );
    });
  });

  describe("getCurrentEpoch", () => {
    it("Should get the current epoch", async () => {
      const { timestamp } = await ethers.provider.getBlock();
      const epochDepositDuration = await pirexCvx.epochDepositDuration();
      const currentEpoch = await pirexCvx.getCurrentEpoch();

      expect(currentEpoch).to.equal(
        Math.floor(timestamp / epochDepositDuration) * epochDepositDuration
      );
    });
  });

  describe("deposit", () => {
    it("Should deposit CVX", async () => {
      const cvxBalanceBeforeDeposit = await cvx.balanceOf(admin.address);
      const vlCvxBalanceBeforeDeposit = await cvxLocker.balanceOf(
        pirexCvx.address
      );
      const depositAmount = ethers.BigNumber.from(`${1e18}`);
      const spendRatio = 0;

      await cvx.approve(pirexCvx.address, depositAmount);

      const { events } = await (
        await pirexCvx.deposit(depositAmount, spendRatio)
      ).wait();
      const depositEvent = events[events.length - 1];
      const rewardsDuration = Number(
        (await cvxLocker.rewardsDuration()).toString()
      );

      // Fast forward 1 rewards duration so that balance is reflected
      await ethers.provider.send("evm_increaseTime", [rewardsDuration]);
      await network.provider.send("evm_mine");

      const cvxBalanceAfterDeposit = await cvx.balanceOf(admin.address);
      const vlCvxBalanceAfterDeposit = await cvxLocker.balanceOf(
        pirexCvx.address
      );
      const currentEpoch = await pirexCvx.getCurrentEpoch();

      // Store to conveniently withdraw tokens for a specific epoch later
      firstDepositEpoch = currentEpoch;

      const { amount: totalAmount, lockExpiry } = await pirexCvx.deposits(
        currentEpoch
      );
      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        depositEvent.args.token
      );
      const pirexVlCVXBalance = await depositToken.balanceOf(admin.address);

      expect(cvxBalanceAfterDeposit).to.equal(
        cvxBalanceBeforeDeposit.sub(depositAmount)
      );
      expect(vlCvxBalanceAfterDeposit).to.equal(
        vlCvxBalanceBeforeDeposit.add(depositAmount)
      );
      expect(depositEvent.eventSignature).to.equal(
        "Deposited(uint256,uint256,uint256,uint256,uint256,address)"
      );
      expect(depositEvent.args.amount).to.equal(depositAmount);
      expect(depositEvent.args.spendRatio).to.equal(spendRatio);
      expect(depositEvent.args.epoch).to.equal(currentEpoch);
      expect(depositEvent.args.totalAmount).to.equal(totalAmount);
      expect(depositEvent.args.lockExpiry).to.equal(lockExpiry);
      expect(depositEvent.args.token).to.not.equal(
        "0x0000000000000000000000000000000000000000"
      );
      expect(pirexVlCVXBalance).to.equal(depositAmount);
    });

    it("Should not mint double vlCVX tokens for users", async () => {
      const currentEpoch = await pirexCvx.getCurrentEpoch();
      const { token } = await pirexCvx.deposits(currentEpoch);
      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        token
      );

      const pirexVlCVXBalanceBefore = await depositToken.balanceOf(
        admin.address
      );
      const depositAmount = ethers.BigNumber.from(`${1e18}`);
      const spendRatio = 0;

      await cvx.approve(pirexCvx.address, depositAmount);
      await pirexCvx.deposit(depositAmount, spendRatio);

      const pirexVlCVXBalanceAfter = await depositToken.balanceOf(
        admin.address
      );

      expect(pirexVlCVXBalanceAfter).to.equal(
        pirexVlCVXBalanceBefore.add(depositAmount)
      );
    });

    it("Should mint a new token for a new epoch", async () => {
      const epochDepositDuration = Number(
        (await pirexCvx.epochDepositDuration()).toString()
      );
      const currentEpoch = await pirexCvx.getCurrentEpoch();
      const { token: currentEpochToken } = await pirexCvx.deposits(
        currentEpoch
      );
      const depositTokenForCurrentEpoch = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        currentEpochToken
      );
      const nextEpoch = currentEpoch.add(epochDepositDuration);
      const depositAmount = ethers.BigNumber.from(`${1e18}`);
      const spendRatio = 0;

      // Store to conveniently withdraw tokens for a specific epoch later
      secondDepositEpoch = nextEpoch;

      // Fast forward 1 epoch
      await ethers.provider.send("evm_increaseTime", [epochDepositDuration]);
      await network.provider.send("evm_mine");

      await cvx.approve(pirexCvx.address, depositAmount);
      await pirexCvx.deposit(depositAmount, spendRatio);

      const { token: nextEpochToken } = await pirexCvx.deposits(nextEpoch);
      const depositTokenForNextEpoch = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        nextEpochToken
      );

      expect(await depositTokenForCurrentEpoch.name()).to.equal(
        `vlCVX-${currentEpoch}`
      );
      expect(await depositTokenForNextEpoch.name()).to.equal(
        `vlCVX-${nextEpoch}`
      );
      expect(await depositTokenForNextEpoch.balanceOf(admin.address)).to.equal(
        depositAmount
      );
    });
  });

  describe("withdraw", () => {
    it("Should revert if withdrawing CVX before lock expiry", async () => {
      const currentEpoch = await pirexCvx.getCurrentEpoch();
      const spendRatio = 0;

      await expect(
        pirexCvx.withdraw(currentEpoch, spendRatio)
      ).to.be.revertedWith("Cannot withdraw before lock expiry");
    });

    it("Should withdraw CVX if after lock expiry (first epoch deposit)", async () => {
      const epochDepositDuration = Number(
        (await pirexCvx.epochDepositDuration()).toString()
      );
      const lockDuration = Number((await pirexCvx.lockDuration()).toString());
      const { token, lockExpiry } = await pirexCvx.deposits(firstDepositEpoch);
      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        token
      );
      const spendRatio = 0;
      const { amount: totalAmount } = await pirexCvx.deposits(
        firstDepositEpoch
      );

      // Fast forward to after lock expiry
      await ethers.provider.send("evm_increaseTime", [
        epochDepositDuration + lockDuration,
      ]);
      await network.provider.send("evm_mine");

      const depositTokenBalanceBeforeWithdraw = await depositToken.balanceOf(
        admin.address
      );
      const cvxBalanceBeforeWithdraw = await cvx.balanceOf(admin.address);
      const timestampAfterIncrease = ethers.BigNumber.from(
        `${(await ethers.provider.getBlock()).timestamp}`
      );

      await depositToken.approve(
        pirexCvx.address,
        depositTokenBalanceBeforeWithdraw
      );
      const { events } = await (
        await pirexCvx.withdraw(firstDepositEpoch, spendRatio)
      ).wait();
      const withdrawEvent = events[events.length - 1];

      const depositTokenBalanceAfterWithdraw = await depositToken.balanceOf(
        admin.address
      );
      const cvxBalanceAfterWithdraw = await cvx.balanceOf(admin.address);

      expect(timestampAfterIncrease.gte(lockExpiry)).to.equal(true);
      expect(depositTokenBalanceAfterWithdraw).to.equal(0);
      expect(cvxBalanceAfterWithdraw).to.equal(
        cvxBalanceBeforeWithdraw.add(depositTokenBalanceBeforeWithdraw)
      );
      expect(withdrawEvent.eventSignature).to.equal(
        "Withdrew(uint256,uint256,uint256,uint256,uint256,address)"
      );
      expect(withdrawEvent.args.amount).to.equal(
        depositTokenBalanceBeforeWithdraw
      );
      expect(withdrawEvent.args.spendRatio).to.equal(spendRatio);
      expect(withdrawEvent.args.epoch).to.equal(firstDepositEpoch);
      expect(withdrawEvent.args.totalAmount).to.equal(totalAmount);
      expect(withdrawEvent.args.lockExpiry).to.equal(lockExpiry);
      expect(withdrawEvent.args.token).to.equal(depositToken.address);
    });

    it("Should withdraw CVX if after lock expiry (second epoch deposit)", async () => {
      const { token } = await pirexCvx.deposits(secondDepositEpoch);
      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        token
      );
      const spendRatio = 0;
      const depositTokenBalanceBeforeWithdraw = await depositToken.balanceOf(
        admin.address
      );
      const cvxBalanceBeforeWithdraw = await cvx.balanceOf(admin.address);

      await depositToken.approve(
        pirexCvx.address,
        depositTokenBalanceBeforeWithdraw
      );
      await pirexCvx.withdraw(secondDepositEpoch, spendRatio);

      const depositTokenBalanceAfterWithdraw = await depositToken.balanceOf(
        admin.address
      );
      const cvxBalanceAfterWithdraw = await cvx.balanceOf(admin.address);

      expect(depositTokenBalanceAfterWithdraw).to.equal(0);
      expect(cvxBalanceAfterWithdraw).to.equal(
        cvxBalanceBeforeWithdraw.add(depositTokenBalanceBeforeWithdraw)
      );
    });
  });

  describe("stake", () => {
    it("Should stake vlCVX", async () => {
      const depositAmount = ethers.BigNumber.from(`${1e18}`);
      const spendRatio = 0;

      await cvx.approve(pirexCvx.address, depositAmount);

      const { events } = await (
        await pirexCvx.deposit(depositAmount, spendRatio)
      ).wait();
      const depositEvent = events[events.length - 1];
      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        depositEvent.args.token
      );
      const depositTokenBalanceBeforeStaking = await depositToken.balanceOf(
        admin.address
      );

      await depositToken.approve(
        pirexCvx.address,
        depositTokenBalanceBeforeStaking
      );
      const { events: stakeEvents } = await (
        await pirexCvx.stake(depositEvent.args.epoch)
      ).wait();
      const stakeEvent = stakeEvents[stakeEvents.length - 1];

      const depositTokenBalanceAfterStaking = await depositToken.balanceOf(
        admin.address
      );

      expect(depositTokenBalanceAfterStaking).to.equal(0);
      expect(stakeEvent.eventSignature).to.equal(
        "Staked(uint256,uint256,uint256)"
      );
      expect(stakeEvent.args.amount).to.equal(depositTokenBalanceBeforeStaking);
      expect(stakeEvent.args.stakedEpoch).to.equal(
        await pirexCvx.getCurrentEpoch()
      );
      expect(stakeEvent.args.lockedEpoch).to.equal(depositEvent.args.epoch);
    });

    it("Should revert if after staking after lockExpiry", async () => {
      const epochDepositDuration = Number(
        (await pirexCvx.epochDepositDuration()).toString()
      );
      const lockDuration = Number((await pirexCvx.lockDuration()).toString());
      const depositAmount = ethers.BigNumber.from(`${1e18}`);
      const spendRatio = 0;

      await cvx.approve(pirexCvx.address, depositAmount);

      const { events } = await (
        await pirexCvx.deposit(depositAmount, spendRatio)
      ).wait();
      const depositEvent = events[events.length - 1];

      // Fast forward to after lock expiry
      await ethers.provider.send("evm_increaseTime", [
        epochDepositDuration + lockDuration,
      ]);
      await network.provider.send("evm_mine");

      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        depositEvent.args.token
      );
      const depositTokenBalanceBeforeStaking = await depositToken.balanceOf(
        admin.address
      );

      await depositToken.approve(
        pirexCvx.address,
        depositTokenBalanceBeforeStaking
      );

      await expect(pirexCvx.stake(depositEvent.args.epoch)).to.be.revertedWith(
        "Cannot stake after lock expiry"
      );
    });

    it("Should revert if caller does not have tokens for epoch", async () => {
      const depositAmount = ethers.BigNumber.from(`${1e18}`);
      const spendRatio = 0;

      await cvx.approve(pirexCvx.address, depositAmount);

      const { events } = await (
        await pirexCvx.deposit(depositAmount, spendRatio)
      ).wait();
      const depositEvent = events[events.length - 1];
      const depositToken = await ethers.getContractAt(
        "ERC20PresetMinterPauserUpgradeable",
        depositEvent.args.token
      );

      const adminBalanceBeforeTransfer = await depositToken.balanceOf(
        admin.address
      );

      await depositToken.transfer(notAdmin.address, adminBalanceBeforeTransfer);

      const adminBalanceAfterTransfer = await depositToken.balanceOf(
        admin.address
      );
      const notAdminBalance = await depositToken.balanceOf(notAdmin.address);

      await expect(pirexCvx.stake(depositEvent.args.epoch)).to.be.revertedWith(
        "Sender does not have vlCVX for epoch"
      );
      expect(adminBalanceAfterTransfer).to.equal(0);
      expect(notAdminBalance).to.equal(adminBalanceBeforeTransfer);
    });
  });
});