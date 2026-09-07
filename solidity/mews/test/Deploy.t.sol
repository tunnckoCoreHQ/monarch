// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {
    ISeaDrop,
    MintParams,
    PublicDrop,
    AllowListData
} from "../src/seadrop/SeaDropInterfaces.sol";
import {Ownable} from "solady/auth/Ownable.sol";

contract DeployTest is Test {
    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant FEE = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address internal constant VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant BUYER = address(0xA11CE);
    address internal constant PAYOUT = 0x6C22d03544609Db5128736706d90D66fC7f45388;
    ISeaDrop internal seaDrop = ISeaDrop(SEA_DROP);
    MewsSeaDrop internal mews;
    MintParams internal creatorStage;
    address internal creator;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(100);
        string memory encoded = vm.readFile("test/fixtures/SeaDrop.hex");
        vm.etch(SEA_DROP, vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1)));
        vm.store(SEA_DROP, bytes32(0), bytes32(uint256(1)));
        encoded = vm.readFile("test/fixtures/TransferValidator.hex");
        vm.etch(VALIDATOR, vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1)));
        vm.setEnv("PRIVATE_START_TIME", "100");
        vm.setEnv("START_TIME", "200");
        vm.setEnv("END_TIME", "300");
        Deploy deploy = Deploy(deployCode("Deploy.s.sol:Deploy"));
        (, mews, creatorStage) = deploy.run();
        creator = mews.owner();
        vm.deal(BUYER, 1 ether);
    }

    function testDeployConfiguresSequentialFreeAndPublicMints() public {
        string memory uri = mews.contractURI();
        assertTrue(LibString.startsWith(uri, "data:application/json;base64,"));
        string memory metadata = string(Base64.decode(LibString.slice(uri, 29)));
        assertEq(vm.parseJsonString(metadata, ".name"), "Mews");
        assertEq(vm.parseJsonString(metadata, ".symbol"), "MEWS");
        address[] memory collaborators = vm.parseJsonAddressArray(metadata, ".collaborators");
        assertEq(collaborators.length, 2);
        assertEq(collaborators[0], 0x9D9db340778139774cF73DFB7Bf27498Fa67978F);
        assertEq(collaborators[1], PAYOUT);
        assertEq(
            vm.parseJsonString(metadata, ".description"),
            "Pixel-perfect pastel Mews, generated and rendered entirely on-chain."
        );
        assertEq(mews.totalSupply(), 2);
        assertEq(mews.ownerOf(1), collaborators[0]);
        assertEq(mews.ownerOf(2), PAYOUT);
        assertEq(creator, PAYOUT);
        assertEq(mews.royaltyAddress(), PAYOUT);
        assertEq(mews.balanceOf(creator), 1);
        assertEq(seaDrop.getCreatorPayoutAddress(address(mews)), PAYOUT);
        assertEq(mews.royaltyBasisPoints(), 500);
        assertEq(mews.getTransferValidator(), VALIDATOR);
        PublicDrop memory publicStage = seaDrop.getPublicDrop(address(mews));
        assertEq(publicStage.mintPrice, 0.000_42 ether);
        assertEq(publicStage.maxTotalMintableByWallet, 10);
        assertEq(publicStage.feeBps, 1000);
        assertTrue(publicStage.restrictFeeRecipients);

        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.NotActive.selector, 100, 200, 300));
        seaDrop.mintPublic{value: 0.000_42 ether}(address(mews), FEE, address(0), 1);
        vm.warp(99);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.NotActive.selector, 99, 100, 199));
        seaDrop.mintAllowList(address(mews), FEE, address(0), 1, creatorStage, new bytes32[](0));

        vm.warp(100);
        vm.prank(creator);
        seaDrop.mintAllowList(address(mews), FEE, address(0), 7, creatorStage, new bytes32[](0));
        vm.warp(199);
        vm.prank(creator);
        seaDrop.mintAllowList(address(mews), FEE, address(0), 11, creatorStage, new bytes32[](0));
        assertEq(mews.totalSupply(), 20);
        assertEq(mews.balanceOf(creator), 19);
        assertEq(PAYOUT.balance, 0);
        assertEq(FEE.balance, 0);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDrop.MintQuantityExceedsMaxTokenSupplyForStage.selector, 21, 20
            )
        );
        seaDrop.mintAllowList(address(mews), FEE, address(0), 1, creatorStage, new bytes32[](0));

        vm.warp(200);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.NotActive.selector, 200, 100, 199));
        seaDrop.mintAllowList(address(mews), FEE, address(0), 1, creatorStage, new bytes32[](0));
        vm.prank(BUYER);
        seaDrop.mintPublic{value: 0.0042 ether}(address(mews), FEE, address(0), 10);
        assertEq(mews.totalSupply(), 30);
        assertEq(mews.balanceOf(BUYER), 10);
        assertEq(PAYOUT.balance, 0.003_78 ether);
        assertEq(FEE.balance, 0.000_42 ether);
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(ISeaDrop.MintQuantityExceedsMaxMintedPerWallet.selector, 11, 10)
        );
        seaDrop.mintPublic{value: 0.000_42 ether}(address(mews), FEE, address(0), 1);
    }

    function testPrivateMintIsBoundToDeployerAndExactTerms() public {
        vm.prank(BUYER);
        vm.expectRevert(ISeaDrop.InvalidProof.selector);
        seaDrop.mintAllowList(address(mews), FEE, address(0), 1, creatorStage, new bytes32[](0));
        MintParams memory changed = creatorStage;
        changed.maxTotalMintableByWallet = 21;
        vm.prank(creator);
        vm.expectRevert(ISeaDrop.InvalidProof.selector);
        seaDrop.mintAllowList(address(mews), FEE, address(0), 1, changed, new bytes32[](0));
        vm.prank(BUYER);
        vm.expectRevert(Ownable.Unauthorized.selector);
        mews.updateAllowList(SEA_DROP, AllowListData(bytes32(0), new string[](0), ""));
        assertEq(mews.totalSupply(), 2);
    }
}
