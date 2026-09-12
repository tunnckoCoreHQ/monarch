// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {DeployForwarder} from "../script/DeployForwarder.s.sol";
import {MewsForwarder} from "../src/MewsForwarder.sol";
import {ILaunchFactory, ILaunchLocker, PoolKey} from "../src/openlaunch/OpenLaunchInterfaces.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ILockerReserves {
    function reserved(address currency) external view returns (uint256);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
        external
        payable;
}

struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

contract DeployForwarderSimulation is DeployForwarder {
    function _startBroadcast() internal override {
        vm.startBroadcast(DEPLOYER);
    }
}

// Runs against Base through `vp run --filter mews test:fork`.
contract MewsForwarderForkTest is Test {
    ILaunchFactory internal constant FACTORY =
        ILaunchFactory(0x815542E8b392389A1389E22E588E4B62A67Ade72);
    ILaunchLocker internal constant LOCKER =
        ILaunchLocker(0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a);
    IUniversalRouter internal constant ROUTER =
        IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address internal constant ACCOUNT = 0x8948da17f04ae9c83dD1fc78976D02cA4e9C7a8e;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant BUYER = address(0xB0B);
    address internal constant KEEPER = address(0xBEEF);
    uint24 internal constant LP_FEE = 10_000;
    bytes internal constant V4_SWAP = hex"10";
    bytes internal constant SWAP_SETTLE_TAKE = hex"060c0f";
    MewsForwarder internal forwarder;
    IERC20 internal token;
    PoolKey internal key;

    function setUp() public {
        DeployForwarder deploy = new DeployForwarderSimulation();
        (MewsForwarder deployed, address launched) = deploy.run("Mews", "MEWS", "", 191_200, LP_FEE);
        forwarder = deployed;
        token = IERC20(launched);
        key = FACTORY.poolKeyOf(launched);
        vm.deal(BUYER, 10 ether);
    }

    function _swap(bool zeroForOne, uint128 amountIn) internal {
        bytes[] memory actions = new bytes[](3);
        actions[0] = abi.encode(ExactInputSingleParams(key, zeroForOne, amountIn, 0, ""));
        actions[1] = abi.encode(zeroForOne ? key.currency0 : key.currency1, uint256(amountIn));
        actions[2] = abi.encode(zeroForOne ? key.currency1 : key.currency0, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(SWAP_SETTLE_TAKE, actions);
        uint256 value = zeroForOne ? amountIn : 0;
        vm.prank(BUYER);
        ROUTER.execute{value: value}(V4_SWAP, inputs, block.timestamp);
    }

    function testDeploymentRoutesFeesToForwarder() public view {
        assertEq(forwarder.token(), address(token));
        assertEq(address(forwarder.locker()), address(LOCKER));
        assertEq(forwarder.account(), ACCOUNT);
        assertEq(forwarder.owner(), ACCOUNT);
        assertTrue(LOCKER.tokenIdOf(address(token)) != 0);
        assertEq(key.currency0, address(0));
        assertEq(key.currency1, address(token));
        assertEq(key.fee, LP_FEE);
    }

    function testFlushBurnsTokenFeesAndPaysEthFees() public {
        _swap(true, 1 ether);
        uint256 bought = token.balanceOf(BUYER);
        assertGt(bought, 0);
        vm.startPrank(BUYER);
        token.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(token), address(ROUTER), type(uint160).max, type(uint48).max);
        vm.stopPrank();
        _swap(false, SafeCastLib.toUint128(bought / 2));

        // The locker sweeps stray ETH to the next collect, so expect the swap fee plus that.
        uint256 stray =
            address(LOCKER).balance - ILockerReserves(address(LOCKER)).reserved(address(0));
        uint256 accountBefore = ACCOUNT.balance;
        uint256 keeperBefore = KEEPER.balance;
        vm.prank(KEEPER);
        forwarder.flush();

        uint256 reward = KEEPER.balance - keeperBefore;
        uint256 ethFees = ACCOUNT.balance - accountBefore + reward;
        assertApproxEqRel(ethFees, 0.01 ether + stray, 0.001e18);
        assertEq(reward, ethFees / 100);
        assertApproxEqRel(token.balanceOf(DEAD), bought / 200, 0.001e18);
        assertEq(token.balanceOf(address(forwarder)), 0);
        assertEq(address(forwarder).balance, 0);
        assertEq(LOCKER.claimable(address(forwarder), address(0)), 0);
        assertEq(LOCKER.claimable(address(forwarder), address(token)), 0);
    }
}
