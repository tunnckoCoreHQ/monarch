// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {DropToken} from "../src/DropToken.sol";
import {Subdrop} from "../src/Subdrop.sol";
import {CANNOT_UNWRAP, PARENT_CANNOT_CONTROL} from "../src/interfaces/INameWrapper.sol";
import {MockNameWrapper} from "./mocks/MockNameWrapper.sol";
import {MockResolver} from "./mocks/MockResolver.sol";

contract MockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Apple1";
    }

    function symbol() public pure override returns (string memory) {
        return "APPLE1";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FalseToken is MockToken {
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

contract RejectingRecipient {
    error ETHRejected();

    receive() external payable {
        revert ETHRejected();
    }
}

/// @dev Mints a second label from inside the subname transfer callback.
contract ReentrantMinter {
    Subdrop internal immutable subdrop;
    bytes32 internal immutable parentNode;
    bool internal reentered;

    constructor(Subdrop subdrop_, bytes32 parentNode_) {
        subdrop = subdrop_;
        parentNode = parentNode_;
    }

    function mint(string calldata label) external payable returns (bytes32) {
        return subdrop.mint{value: msg.value}(parentNode, label);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        if (!reentered) {
            reentered = true;
            subdrop.mint{value: address(this).balance}(parentNode, "second");
        }

        return this.onERC1155Received.selector;
    }
}

contract SubdropTest is Test {
    uint32 internal constant IS_DOT_ETH = 1 << 17;
    uint96 internal constant PRICE = 0.001 ether;
    uint96 internal constant REWARD = 100e18;
    uint64 internal constant PARENT_EXPIRY = 2_000_000_000;

    bytes32 internal constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;
    bytes32 internal parentNode = _subnode(ETH_NODE, "apple1");

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal minter = makeAddr("minter");
    address internal stranger = makeAddr("stranger");

    MockNameWrapper internal nameWrapper;
    MockResolver internal resolver;
    MockToken internal token;
    Subdrop internal subdrop;

    function setUp() public {
        vm.warp(1_700_000_000);

        nameWrapper = new MockNameWrapper();
        resolver = new MockResolver(nameWrapper);
        token = new MockToken();
        subdrop = new Subdrop(address(nameWrapper), address(resolver));

        nameWrapper.wrap(parentNode, owner, CANNOT_UNWRAP | IS_DOT_ETH, PARENT_EXPIRY);
        token.mint(owner, 1_000_000e18);

        vm.startPrank(owner);
        nameWrapper.setApprovalForAll(address(subdrop), true);
        token.approve(address(subdrop), 1000e18);
        subdrop.configure(parentNode, _config(REWARD, PRICE, 0));
        vm.stopPrank();

        vm.deal(minter, 1 ether);
        vm.deal(stranger, 1 ether);
    }

    function test_ConfigureStoresDrop() public view {
        (
            address dropOwner,
            address dropToken,
            address feeRecipient,
            uint96 price,
            uint96 reward,
            uint32 fuses,
            uint32 maxMints,
            uint32 minted,
            bool paused
        ) = subdrop.drops(parentNode);

        assertEq(dropOwner, owner);
        assertEq(dropToken, address(token));
        assertEq(feeRecipient, treasury);
        assertEq(price, PRICE);
        assertEq(reward, REWARD);
        assertEq(fuses, PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);
        assertEq(maxMints, 0);
        assertEq(minted, 0);
        assertFalse(paused);
    }

    function test_RevertWhen_DeployWithZeroAddress() public {
        vm.expectRevert(Subdrop.ZeroAddress.selector);
        new Subdrop(address(0), address(resolver));

        vm.expectRevert(Subdrop.ZeroAddress.selector);
        new Subdrop(address(nameWrapper), address(0));
    }

    function test_ReconfigureKeepsMintedCount() public {
        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");

        vm.prank(owner);
        subdrop.configure(parentNode, _config(REWARD * 2, 0, 5));

        (,,,, uint96 reward,, uint32 maxMints, uint32 minted,) = subdrop.drops(parentNode);
        assertEq(reward, REWARD * 2);
        assertEq(maxMints, 5);
        assertEq(minted, 1);
        assertEq(subdrop.remaining(parentNode), 4);
    }

    function test_RevertWhen_ConfigureByNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Subdrop.NotParentOwner.selector);
        subdrop.configure(parentNode, _config(REWARD, PRICE, 0));
    }

    function test_RevertWhen_ConfigureWithZeroToken() public {
        Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);
        config.token = address(0);

        vm.prank(owner);
        vm.expectRevert(Subdrop.ZeroAddress.selector);
        subdrop.configure(parentNode, config);
    }

    function test_RevertWhen_ParentHasNotBurnedCannotUnwrap() public {
        bytes32 looseParent = _subnode(ETH_NODE, "loose");
        nameWrapper.wrap(looseParent, owner, IS_DOT_ETH, PARENT_EXPIRY);

        vm.prank(owner);
        vm.expectRevert(Subdrop.ParentCannotBurnFuses.selector);
        subdrop.configure(looseParent, _config(REWARD, PRICE, 0));
    }

    function test_RevertWhen_ConfigureFusesNameWrapperRejects() public {
        uint32[3] memory rejected = [CANNOT_UNWRAP, uint32(4), IS_DOT_ETH];

        for (uint256 i = 0; i < rejected.length; i++) {
            Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);
            config.fuses = rejected[i];

            vm.prank(owner);
            vm.expectRevert(Subdrop.InvalidFuses.selector);
            subdrop.configure(parentNode, config);
        }
    }

    function test_ConfigureParentOnlyFuses() public {
        Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);
        config.fuses = PARENT_CANNOT_CONTROL;
        vm.prank(owner);
        subdrop.configure(parentNode, config);

        vm.prank(minter);
        bytes32 node = subdrop.mint{value: PRICE}(parentNode, "dan");
        (, uint32 fuses,) = nameWrapper.getData(uint256(node));
        assertEq(fuses, PARENT_CANNOT_CONTROL);
    }

    function test_RemainingIsZeroWhenCapLoweredBelowMinted() public {
        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");
        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "eve");

        vm.prank(owner);
        subdrop.configure(parentNode, _config(REWARD, PRICE, 1));

        assertEq(subdrop.remaining(parentNode), 0);
        vm.prank(minter);
        vm.expectRevert(Subdrop.MintedOut.selector);
        subdrop.mint{value: PRICE}(parentNode, "sam");
    }

    function test_RevertWhen_ReceivingUnexpectedERC1155() public {
        vm.expectRevert(Subdrop.UnexpectedToken.selector);
        subdrop.onERC1155Received(address(subdrop), address(0), 1, 1, "");

        bytes32 node = _subnode(parentNode, "held");
        nameWrapper.wrap(node, stranger, 0, PARENT_EXPIRY);
        vm.prank(stranger);
        vm.expectRevert(Subdrop.UnexpectedToken.selector);
        nameWrapper.safeTransferFrom(stranger, address(subdrop), uint256(node), 1, "");
    }

    function test_ConfigureWithoutParentFusesOnLooseParent() public {
        bytes32 looseParent = _subnode(ETH_NODE, "loose");
        nameWrapper.wrap(looseParent, owner, IS_DOT_ETH, PARENT_EXPIRY);
        Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);
        config.fuses = 0;

        vm.prank(owner);
        subdrop.configure(looseParent, config);

        (address dropOwner,,,,,,,,) = subdrop.drops(looseParent);
        assertEq(dropOwner, owner);
    }

    function test_MintGivesSubnameAndReward() public {
        bytes32 node = _subnode(parentNode, "dan");

        vm.prank(minter);
        vm.expectEmit(true, true, true, true, address(subdrop));
        emit Subdrop.Minted(parentNode, node, minter, "dan", PRICE, REWARD);
        bytes32 minted = subdrop.mint{value: PRICE}(parentNode, "dan");

        assertEq(minted, node);
        (address nodeOwner, uint32 fuses, uint64 expiry) = nameWrapper.getData(uint256(node));
        assertEq(nodeOwner, minter);
        assertEq(fuses, PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);
        assertEq(expiry, PARENT_EXPIRY);
        assertEq(nameWrapper.resolverOf(node), address(resolver));
        assertEq(nameWrapper.labelOf(node), "dan");
        assertEq(resolver.addr(node), minter);

        assertEq(token.balanceOf(minter), REWARD);
        assertEq(token.balanceOf(owner), 1_000_000e18 - REWARD);
        assertEq(treasury.balance, PRICE);
        assertEq(address(subdrop).balance, 0);

        (,,,,,,, uint32 mintedCount,) = subdrop.drops(parentNode);
        assertEq(mintedCount, 1);
    }

    function test_MintFreeDropWithoutRewardOrPayment() public {
        vm.prank(owner);
        subdrop.configure(parentNode, _config(0, 0, 0));

        vm.prank(minter);
        bytes32 node = subdrop.mint(parentNode, "free");

        assertEq(nameWrapper.ownerOf(uint256(node)), minter);
        assertEq(token.balanceOf(minter), 0);
        assertEq(treasury.balance, 0);
    }

    function test_RevertWhen_MintWithWrongPayment() public {
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(Subdrop.IncorrectPayment.selector, 0, PRICE));
        subdrop.mint(parentNode, "dan");
    }

    function test_RevertWhen_MintTakenLabel() public {
        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");

        vm.prank(stranger);
        vm.expectRevert(Subdrop.LabelTaken.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_MintInvalidLabel() public {
        string[5] memory labels = ["", "Dan", "d.an", "d an", "dan\x7f"];

        for (uint256 i = 0; i < labels.length; i++) {
            assertFalse(subdrop.available(parentNode, labels[i]));

            vm.prank(minter);
            vm.expectRevert(Subdrop.InvalidLabel.selector);
            subdrop.mint{value: PRICE}(parentNode, labels[i]);
        }
    }

    function test_AvailableUntilMinted() public {
        assertTrue(subdrop.available(parentNode, "dan"));

        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");

        assertFalse(subdrop.available(parentNode, "dan"));
    }

    function test_MintExpiredSubnameAgain() public {
        bytes32 node = _subnode(parentNode, "dan");
        nameWrapper.wrap(node, stranger, 0, uint64(block.timestamp + 1));
        assertFalse(subdrop.available(parentNode, "dan"));

        vm.warp(block.timestamp + 2);
        assertTrue(subdrop.available(parentNode, "dan"));

        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");
        assertEq(nameWrapper.ownerOf(uint256(node)), minter);
    }

    function test_ReentrantMinterPaysForEveryMint() public {
        ReentrantMinter reentrant = new ReentrantMinter(subdrop, parentNode);
        vm.deal(address(reentrant), PRICE);

        vm.prank(minter);
        reentrant.mint{value: PRICE}("first");

        assertEq(nameWrapper.ownerOf(uint256(_subnode(parentNode, "first"))), address(reentrant));
        assertEq(nameWrapper.ownerOf(uint256(_subnode(parentNode, "second"))), address(reentrant));
        assertEq(token.balanceOf(address(reentrant)), REWARD * 2);
        assertEq(treasury.balance, PRICE * 2);
        (,,,,,,, uint32 minted,) = subdrop.drops(parentNode);
        assertEq(minted, 2);
    }

    function test_RevertWhen_FeeRecipientRejectsETH() public {
        Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);
        config.feeRecipient = address(new RejectingRecipient());
        vm.prank(owner);
        subdrop.configure(parentNode, config);

        vm.prank(minter);
        vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_RewardTokenReturnsFalse() public {
        FalseToken falseToken = new FalseToken();
        falseToken.mint(owner, REWARD);
        Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);
        config.token = address(falseToken);
        vm.startPrank(owner);
        falseToken.approve(address(subdrop), REWARD);
        subdrop.configure(parentNode, config);
        vm.stopPrank();

        vm.prank(minter);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_LaunchByNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Subdrop.NotParentOwner.selector);
        subdrop.launch(parentNode, "Apple One", "APPLE1", 1, _config(REWARD, PRICE, 0));
    }

    function testFuzz_LabelValidation(bytes memory raw) public view {
        bool expected = raw.length != 0;
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];
            bool forbidden = char <= 0x20 || char == 0x2E || char == 0x7F;
            bool uppercase = char >= 0x41 && char <= 0x5A;
            if (forbidden || uppercase) {
                expected = false;
            }
        }

        assertEq(subdrop.available(parentNode, string(raw)), expected);
    }

    function test_MintUnicodeLabel() public {
        vm.prank(minter);
        bytes32 node = subdrop.mint{value: PRICE}(parentNode, unicode"🍎");

        assertEq(nameWrapper.ownerOf(uint256(node)), minter);
    }

    function test_RevertWhen_DropNotFound() public {
        vm.prank(minter);
        vm.expectRevert(Subdrop.DropNotFound.selector);
        subdrop.mint{value: PRICE}(_subnode(ETH_NODE, "nobody"), "dan");
    }

    function test_RevertWhen_MintPaused() public {
        vm.prank(owner);
        subdrop.setPaused(parentNode, true);
        assertEq(subdrop.remaining(parentNode), 0);

        vm.prank(minter);
        vm.expectRevert(Subdrop.DropIsPaused.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");

        vm.prank(owner);
        subdrop.setPaused(parentNode, false);

        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_PauseByNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Subdrop.NotParentOwner.selector);
        subdrop.setPaused(parentNode, true);
    }

    function test_RevertWhen_MintedOut() public {
        vm.prank(owner);
        subdrop.configure(parentNode, _config(REWARD, PRICE, 1));

        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");
        assertEq(subdrop.remaining(parentNode), 0);

        vm.prank(stranger);
        vm.expectRevert(Subdrop.MintedOut.selector);
        subdrop.mint{value: PRICE}(parentNode, "eve");
    }

    function test_RevertWhen_RewardBudgetExhausted() public {
        vm.prank(owner);
        token.approve(address(subdrop), REWARD - 1);
        assertEq(subdrop.remaining(parentNode), 0);

        vm.prank(minter);
        vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_ParentOwnerChanged() public {
        nameWrapper.wrap(parentNode, stranger, CANNOT_UNWRAP | IS_DOT_ETH, PARENT_EXPIRY);

        vm.prank(minter);
        vm.expectRevert(Subdrop.ParentOwnerChanged.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_NotNameWrapperOperator() public {
        vm.prank(owner);
        nameWrapper.setApprovalForAll(address(subdrop), false);

        vm.prank(minter);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockNameWrapper.Unauthorised.selector, parentNode, address(subdrop)
            )
        );
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_LaunchDeploysTokenAndMints() public {
        Subdrop.DropConfig memory config = _config(REWARD, PRICE, 0);

        vm.prank(owner);
        address launched = subdrop.launch(parentNode, "Apple One", "APPLE1", 1_000_000e18, config);

        DropToken dropToken = DropToken(launched);
        assertEq(dropToken.name(), "Apple One");
        assertEq(dropToken.symbol(), "APPLE1");
        assertEq(dropToken.totalSupply(), 1_000_000e18);
        assertEq(dropToken.balanceOf(owner), 1_000_000e18);
        assertEq(dropToken.allowance(owner, address(subdrop)), type(uint256).max);
        (, address configuredToken,,,,,,,) = subdrop.drops(parentNode);
        assertEq(configuredToken, launched);

        vm.prank(minter);
        subdrop.mint{value: PRICE}(parentNode, "dan");
        assertEq(dropToken.balanceOf(minter), REWARD);
    }

    function test_RevertWhen_LaunchedTokenInitializedTwice() public {
        vm.prank(owner);
        address launched = subdrop.launch(
            parentNode, "Apple One", "APPLE1", 1_000_000e18, _config(REWARD, PRICE, 0)
        );

        vm.expectRevert(DropToken.AlreadyInitialized.selector);
        DropToken(launched).initialize("Evil", "EVIL", 1, stranger, stranger);

        DropToken implementation = DropToken(subdrop.tokenImplementation());
        vm.expectRevert(DropToken.AlreadyInitialized.selector);
        implementation.initialize("Evil", "EVIL", 1, stranger, stranger);
    }

    function test_RemainingTakesSmallestBound() public {
        assertEq(subdrop.remaining(parentNode), 10);

        vm.prank(owner);
        subdrop.configure(parentNode, _config(REWARD, PRICE, 3));
        assertEq(subdrop.remaining(parentNode), 3);

        vm.prank(owner);
        assertTrue(token.transfer(stranger, 1_000_000e18 - REWARD));
        assertEq(subdrop.remaining(parentNode), 1);
    }

    function test_RemainingUnlimitedWithoutReward() public {
        vm.prank(owner);
        subdrop.configure(parentNode, _config(0, PRICE, 0));

        assertEq(subdrop.remaining(parentNode), type(uint256).max);
    }

    function testFuzz_RemainingNeverExceedsCap(uint32 maxMints, uint96 allowance) public {
        vm.startPrank(owner);
        token.approve(address(subdrop), allowance);
        subdrop.configure(parentNode, _config(REWARD, PRICE, maxMints));
        vm.stopPrank();

        uint256 count = subdrop.remaining(parentNode);
        assertLe(count, uint256(allowance) / REWARD);
        if (maxMints != 0) {
            assertLe(count, maxMints);
        }
    }

    function _config(uint96 reward, uint96 price, uint32 maxMints)
        internal
        view
        returns (Subdrop.DropConfig memory)
    {
        return Subdrop.DropConfig({
            token: address(token),
            feeRecipient: treasury,
            price: price,
            reward: reward,
            fuses: PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
            maxMints: maxMints
        });
    }

    function _subnode(bytes32 parentNode_, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode_, keccak256(bytes(label))));
    }
}
