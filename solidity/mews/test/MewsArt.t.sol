// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC721A} from "erc721a/IERC721A.sol";
import {Mews} from "../src/Mews.sol";
import {MewsArt} from "../src/MewsArt.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {ISeaDrop} from "../src/seadrop/SeaDropInterfaces.sol";

contract MewsArtTest is Test {
    bytes32 internal constant GENESIS = keccak256("Mews shared art tests");
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    MewsRenderer internal renderer;
    Mews internal mews;

    function setUp() public {
        renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        mews = new Mews(GENESIS, renderer);
    }

    function testSeedsUseGenesisMinterAddressAndTokenId() public {
        vm.prank(ALICE);
        mews.mint(3);
        for (uint256 id = 1; id <= 3; ++id) {
            bytes32 expected = keccak256(abi.encode(GENESIS, keccak256(abi.encode(ALICE)), id));
            assertEq(mews.tokenSeed(id), expected);
            assertEq(mews.mintSeed(ALICE, id), expected);
            assertEq(renderer.mintSeed(GENESIS, ALICE, id), expected);
        }
        assertNotEq(mews.mintSeed(ALICE, 1), mews.mintSeed(BOB, 1));
        assertNotEq(mews.mintSeed(ALICE, 1), mews.mintSeed(ALICE, 2));
        assertNotEq(mews.mintSeed(ALICE, 1), renderer.mintSeed(bytes32(0), ALICE, 1));
    }

    function testBatchAndSeparateMintsProduceTheSameArt() public {
        Mews split = new Mews(GENESIS, renderer);
        vm.startPrank(ALICE);
        mews.mint(3);
        split.mint(1);
        split.mint(2);
        vm.stopPrank();
        for (uint256 id = 1; id <= 3; ++id) {
            assertEq(mews.tokenURI(id), split.tokenURI(id));
        }
    }

    function testBothNftWrappersUseTheSameRendererCore() public {
        address drop = address(0x5EA);
        MewsSeaDrop seaDropNft = MewsSeaDrop(
            deployCode("MewsSeaDrop.sol:MewsSeaDrop", abi.encode(GENESIS, renderer, ISeaDrop(drop)))
        );
        vm.prank(0x9D9db340778139774cF73DFB7Bf27498Fa67978F);
        mews.mint(1);
        vm.prank(0x6C22d03544609Db5128736706d90D66fC7f45388);
        mews.mint(1);
        vm.prank(ALICE);
        mews.mint(3);
        vm.prank(drop);
        seaDropNft.mintSeaDrop(ALICE, 3);
        for (uint256 id = 1; id <= 5; ++id) {
            assertEq(mews.tokenSeed(id), seaDropNft.tokenSeed(id));
            assertEq(mews.tokenURI(id), seaDropNft.tokenURI(id));
            assertEq(abi.encode(mews.tokenData(id)), abi.encode(seaDropNft.tokenData(id)));
        }
    }

    function testMintDoesNotCallRenderer() public {
        bytes memory code = address(renderer).code;
        vm.etch(address(renderer), hex"60006000fd");
        Mews another = new Mews(GENESIS, renderer);
        vm.prank(ALICE);
        another.mint(3);
        assertEq(another.totalSupply(), 3);
        vm.etch(address(renderer), code);
        assertEq(another.tokenSeed(3), mews.mintSeed(ALICE, 3));
    }

    function testSharedGenerationUnlockAndOwnership() public {
        vm.prank(ALICE);
        mews.mint(499);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, address(this), 2);
        MewsRenderer.Traits memory selected = renderer.traits(GENESIS);
        vm.expectRevert(MewsArt.GenerationLocked.selector);
        mews.generate(GENESIS);
        vm.expectRevert(MewsArt.GenerationLocked.selector);
        mews.generate(selected);
        vm.prank(ALICE);
        mews.mint(1);
        assertEq(abi.encode(mews.generate(GENESIS)), abi.encode(renderer.generate(GENESIS)));
        assertEq(abi.encode(mews.generate(selected)), abi.encode(renderer.generate(selected)));
        assertEq(mews.totalSupply(), 500);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenData(501);

        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(GENESIS);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(selected);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, BOB, 1);
        vm.prank(BOB);
        mews.generate(GENESIS);
        vm.prank(BOB);
        mews.generate(selected);
        vm.prank(BOB);
        mews.transferFrom(BOB, ALICE, 1);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(GENESIS);

        vm.prank(ALICE);
        mews.mint(500);
        mews.generate(GENESIS);
        mews.generate(selected);
        assertEq(mews.totalSupply(), 1000);
    }

    function testMintRejectsZeroQuantity() public {
        vm.prank(ALICE);
        vm.expectRevert(MewsArt.InvalidMint.selector);
        mews.mint(0);
    }
}
