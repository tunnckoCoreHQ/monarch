// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {ISeaDrop, PublicDrop} from "../src/seadrop/SeaDropInterfaces.sol";

// Exercise deployment without needing the real wallet's signing key in tests.
contract DeploySimulation is Deploy {
    function _startBroadcast() internal override {
        vm.startBroadcast(DEPLOYER);
    }
}

contract DeployTest is Test {
    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant FEE = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address internal constant VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant BUYER = address(0xA11CE);
    address internal constant OWNER = 0x6C22d03544609Db5128736706d90D66fC7f45388;
    address internal constant COLLABORATOR = 0x9D9db340778139774cF73DFB7Bf27498Fa67978F;
    ISeaDrop internal seaDrop = ISeaDrop(SEA_DROP);
    MewsSeaDrop internal mews;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1000);
        string memory encoded = vm.readFile("test/fixtures/SeaDrop.hex");
        vm.etch(SEA_DROP, vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1)));
        vm.store(SEA_DROP, bytes32(0), bytes32(uint256(1)));
        encoded = vm.readFile("test/fixtures/TransferValidator.hex");
        vm.etch(VALIDATOR, vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1)));
        Deploy deploy = Deploy(deployCode("Deploy.t.sol:DeploySimulation"));
        (, mews) = deploy.run();
        vm.deal(BUYER, 1 ether);
    }

    function testDeploymentSetsAllocationAndRoyalties() public view {
        assertEq(mews.owner(), OWNER);
        assertEq(mews.totalSupply(), 20);
        assertEq(mews.balanceOf(COLLABORATOR), 5);
        assertEq(mews.balanceOf(OWNER), 15);
        assertEq(mews.ownerOf(5), COLLABORATOR);
        assertEq(mews.ownerOf(6), OWNER);
        assertEq(mews.ownerOf(20), OWNER);
        assertEq(mews.royaltyAddress(), OWNER);
        assertEq(mews.royaltyBasisPoints(), 500);
        assertEq(mews.getTransferValidator(), VALIDATOR);
    }

    function testDeploymentLeavesSeaDropUnconfiguredAndMintClosed() public {
        assertEq(mews.contractURI(), "");
        assertEq(seaDrop.getCreatorPayoutAddress(address(mews)), address(0));
        assertEq(seaDrop.getAllowListMerkleRoot(address(mews)), bytes32(0));
        assertFalse(seaDrop.getFeeRecipientIsAllowed(address(mews), FEE));
        PublicDrop memory stage = seaDrop.getPublicDrop(address(mews));
        assertEq(stage.startTime, 0);
        assertEq(stage.endTime, 0);
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.NotActive.selector, 1000, 0, 0));
        seaDrop.mintPublic{value: 0.000_42 ether}(address(mews), FEE, address(0), 1);
    }

    function testDeploymentRejectsWrongSigningKey() public {
        vm.setEnv("PRIVATE_KEY", "1");
        Deploy deploy = Deploy(deployCode("Deploy.s.sol:Deploy"));
        vm.expectRevert(Deploy.InvalidDeployerKey.selector);
        deploy.run();
    }

    function testDeploymentRejectsOtherChains() public {
        vm.chainId(1);
        Deploy deploy = Deploy(deployCode("Deploy.t.sol:DeploySimulation"));
        vm.expectRevert(Deploy.InvalidConfiguration.selector);
        deploy.run();
    }
}
