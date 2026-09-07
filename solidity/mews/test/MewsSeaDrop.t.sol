// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {IERC721A} from "erc721a/IERC721A.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {MewsArt} from "../src/MewsArt.sol";
import {RejectingReceiver} from "./Mews.t.sol";
import {
    ISeaDrop,
    INonFungibleSeaDropToken,
    ISeaDropTokenContractMetadata,
    IERC2981,
    PublicDrop
} from "../src/seadrop/SeaDropInterfaces.sol";

contract SeaDropReceiver {
    MewsSeaDrop private _nft;
    bytes public rejection;
    bytes32 public observedSeed;
    uint256 public observedMinted;
    uint256 public observedSupply;

    function mint(MewsSeaDrop nft, ISeaDrop drop, address fee) external payable {
        _nft = nft;
        drop.mintPublic{value: msg.value}(address(nft), fee, address(0), 1);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        returns (bytes4)
    {
        (observedMinted, observedSupply,) = _nft.getMintStats(address(this));
        observedSeed = _nft.tokenData(tokenId).seed;
        try _nft.mintSeaDrop(address(this), 1) {}
        catch (bytes memory reason) {
            rejection = reason;
        }
        return this.onERC721Received.selector;
    }
}

contract MewsSeaDropTest is Test {
    // Base block 50965136, fetched from https://mainnet.base.org.
    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    bytes32 internal constant CODE_HASH =
        0x2151e8d092f04e5cf00576bf5e6b92a0fc15b0013dc8c08b68934048d39ac1fc;
    bytes32 internal constant GENESIS = keccak256("Mews SeaDrop tests");
    uint80 internal constant PRICE = 0.001 ether;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant PAYOUT = address(0xCAFE);
    address internal constant FEE = address(0xFEE);
    ISeaDrop internal seaDrop;
    MewsRenderer internal renderer;
    MewsSeaDrop internal mews;
    mapping(bytes32 => bool) private _seenImages;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1000);
        string memory encoded = vm.readFile("test/fixtures/SeaDrop.hex");
        bytes memory runtime = vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1));
        assertEq(keccak256(runtime), CODE_HASH);
        vm.etch(SEA_DROP, runtime);
        vm.store(SEA_DROP, bytes32(0), bytes32(uint256(1)));
        seaDrop = ISeaDrop(SEA_DROP);
        renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        mews = _deploy(GENESIS);
        mews.updateCreatorPayoutAddress(SEA_DROP, PAYOUT);
        mews.updateAllowedFeeRecipient(SEA_DROP, FEE, true);
        mews.updatePublicDrop(SEA_DROP, PublicDrop(PRICE, 100, 2000, 5, 500, true));
        vm.deal(ALICE, 10 ether);
        vm.deal(BOB, 10 ether);
    }

    function _deploy(bytes32 genesis) internal returns (MewsSeaDrop) {
        return MewsSeaDrop(
            deployCode("MewsSeaDrop.sol:MewsSeaDrop", abi.encode(genesis, renderer, seaDrop))
        );
    }

    function _mintAlice(uint256 quantity) internal {
        vm.prank(ALICE);
        seaDrop.mintPublic{value: PRICE * quantity}(address(mews), FEE, address(0), quantity);
    }

    function testConstructorMintsOneToEachCollaborator() public view {
        assertEq(mews.owner(), address(this));
        assertEq(mews.totalSupply(), 2);
        assertEq(mews.ownerOf(1), 0x9D9db340778139774cF73DFB7Bf27498Fa67978F);
        assertEq(mews.ownerOf(2), 0x6C22d03544609Db5128736706d90D66fC7f45388);
        assertEq(mews.balanceOf(address(this)), 0);
        assertEq(mews.provenanceHash(), GENESIS);
        assertTrue(mews.supportsInterface(type(INonFungibleSeaDropToken).interfaceId));
        assertTrue(mews.supportsInterface(type(IERC2981).interfaceId));
        assertFalse(mews.supportsInterface(0xffffffff));
        assertLe(address(mews).code.length, 24_576);
    }

    function testRealSeaDropPaidMintNeedsNoRegistration() public {
        _mintAlice(3);
        assertEq(mews.balanceOf(ALICE), 3);
        assertEq(mews.ownerOf(3), ALICE);
        assertEq(mews.ownerOf(5), ALICE);
        assertEq(mews.tokenSeed(3), mews.mintSeed(ALICE, 3));
        assertEq(mews.tokenData(3).seed, mews.tokenSeed(3));
        assertEq(mews.tokenURI(3), renderer.tokenURI(3, mews.tokenSeed(3)));
        assertEq(PAYOUT.balance, uint256(PRICE) * 3 * 95 / 100);
        assertEq(FEE.balance, uint256(PRICE) * 3 * 5 / 100);
    }

    function testConstructorDoesNotCallRecipientCode() public {
        address first = 0x9D9db340778139774cF73DFB7Bf27498Fa67978F;
        address second = 0x6C22d03544609Db5128736706d90D66fC7f45388;
        vm.etch(first, hex"60006000fd");
        vm.etch(second, hex"60006000fd");
        MewsSeaDrop fresh = _deploy(GENESIS);
        assertEq(fresh.balanceOf(first), 1);
        assertEq(fresh.balanceOf(second), 1);
        assertEq(fresh.tokenSeed(1), fresh.mintSeed(first, 1));
        assertEq(fresh.tokenSeed(2), fresh.mintSeed(second, 2));
    }

    function testOnlySeaDropCanMint() public {
        vm.prank(ALICE);
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        mews.mintSeaDrop(ALICE, 1);
    }

    function testMintDoesNotRenderSVGOrJSON() public {
        vm.mockCallRevert(address(renderer), MewsRenderer.render.selector, hex"01");
        vm.mockCallRevert(address(renderer), MewsRenderer.tokenURI.selector, hex"01");
        MewsSeaDrop fresh = _deploy(GENESIS);
        assertEq(fresh.totalSupply(), 2);
        _mintAlice(3);
        assertEq(mews.totalSupply(), 5);
        assertEq(mews.tokenData(5).seed, mews.mintSeed(ALICE, 5));
    }

    function testOriginalMintersSurviveTransfersAndBatchBoundaries() public {
        _mintAlice(3);
        vm.prank(BOB);
        seaDrop.mintPublic{value: PRICE * 2}(address(mews), FEE, address(0), 2);
        string memory original = mews.tokenURI(4);
        bytes memory raw = abi.encode(mews.tokenData(4));
        vm.startPrank(ALICE);
        mews.transferFrom(ALICE, BOB, 4);
        mews.transferFrom(ALICE, BOB, 3);
        vm.stopPrank();
        vm.prank(BOB);
        mews.transferFrom(BOB, ALICE, 6);
        for (uint256 id = 3; id <= 5; ++id) {
            assertEq(mews.tokenSeed(id), mews.mintSeed(ALICE, id));
        }
        assertEq(mews.tokenSeed(6), mews.mintSeed(BOB, 6));
        assertEq(mews.tokenSeed(7), mews.mintSeed(BOB, 7));
        assertEq(mews.tokenURI(4), original);
        assertEq(abi.encode(mews.tokenData(4)), raw);
    }

    function testSeaDropEnforcesWalletCapAfterTransfers() public {
        _mintAlice(3);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, BOB, 3);
        _mintAlice(2);
        vm.expectRevert(
            abi.encodeWithSelector(ISeaDrop.MintQuantityExceedsMaxMintedPerWallet.selector, 6, 5)
        );
        _mintAlice(1);
        (uint256 minted,,) = mews.getMintStats(ALICE);
        assertEq(minted, 5);
        assertEq(mews.balanceOf(ALICE), 4);
    }

    function testWrongPaymentFeeRecipientAndClosedWindow() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.IncorrectPayment.selector, 0, PRICE));
        seaDrop.mintPublic(address(mews), FEE, address(0), 1);
        vm.prank(ALICE);
        vm.expectRevert(ISeaDrop.FeeRecipientNotAllowed.selector);
        seaDrop.mintPublic{value: PRICE}(address(mews), BOB, address(0), 1);
        vm.warp(2001);
        vm.expectRevert(abi.encodeWithSelector(ISeaDrop.NotActive.selector, 2001, 100, 2000));
        _mintAlice(1);
    }

    function testOwnerCanConfigureOnlyTheSelectedSeaDrop() public {
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        mews.updatePublicDrop(SEA_DROP, PublicDrop(0, 100, 2000, 5, 0, false));
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        mews.updateCreatorPayoutAddress(BOB, PAYOUT);
        mews.updateCreatorPayoutAddress(SEA_DROP, BOB);
        assertEq(seaDrop.getCreatorPayoutAddress(address(mews)), BOB);
    }

    function testProvenanceCannotChangeAndRoyaltiesCan() public {
        vm.expectRevert(MewsSeaDrop.ProvenanceHashImmutable.selector);
        mews.setProvenanceHash(bytes32(uint256(1)));
        assertEq(mews.provenanceHash(), GENESIS);
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        mews.setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo(PAYOUT, 500));
        mews.setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo(PAYOUT, 500));
        (address receiver, uint256 amount) = mews.royaltyInfo(1, 1 ether);
        assertEq(receiver, PAYOUT);
        assertEq(amount, 0.05 ether);
        mews.setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo(BOB, 10_000));
        (receiver, amount) = mews.royaltyInfo(1, type(uint256).max);
        assertEq(receiver, BOB);
        assertEq(amount, type(uint256).max);
    }

    function testOnlyOwnerCanUpdateContractURI() public {
        string memory previous = mews.contractURI();
        vm.prank(0x9D9db340778139774cF73DFB7Bf27498Fa67978F);
        vm.expectRevert(Ownable.Unauthorized.selector);
        mews.setContractURI("ipfs://updated-mews");
        assertEq(mews.contractURI(), previous);
        vm.expectEmit(false, false, false, true, address(mews));
        emit MewsSeaDrop.ContractURIUpdated();
        mews.setContractURI("ipfs://updated-mews");
        assertEq(mews.contractURI(), "ipfs://updated-mews");
    }

    function testNonexistentTokensHaveNoSeedOrData() public {
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenSeed(3);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenData(3);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenURI(0);
    }

    function testReceiverCannotReenterMint() public {
        SeaDropReceiver receiver = new SeaDropReceiver();
        vm.deal(address(this), PRICE);
        receiver.mint{value: PRICE}(mews, seaDrop, FEE);
        assertEq(receiver.rejection(), abi.encodeWithSelector(ReentrancyGuard.Reentrancy.selector));
        assertEq(receiver.observedMinted(), 1);
        assertEq(receiver.observedSupply(), 3);
        assertEq(receiver.observedSeed(), mews.mintSeed(address(receiver), 3));
    }

    function testRejectedReceiverRollsBackPaymentAndMint() public {
        RejectingReceiver receiver = new RejectingReceiver();
        vm.deal(address(receiver), PRICE);
        vm.prank(address(receiver));
        vm.expectRevert(IERC721A.TransferToNonERC721ReceiverImplementer.selector);
        seaDrop.mintPublic{value: PRICE}(address(mews), FEE, address(0), 1);
        assertEq(address(receiver).balance, PRICE);
        assertEq(PAYOUT.balance, 0);
        assertEq(mews.totalSupply(), 2);
        _mintAlice(1);
        assertEq(mews.tokenSeed(3), mews.mintSeed(ALICE, 3));
    }

    function testGenerationUnlocksAtFiveHundredAndDoesNotMint() public {
        mews.updatePublicDrop(SEA_DROP, PublicDrop(PRICE, 100, 2000, 1000, 500, true));
        _mintAlice(497);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, address(this), 3);
        MewsRenderer.Traits memory selected = renderer.traits(GENESIS);
        vm.expectRevert(MewsArt.GenerationLocked.selector);
        mews.generate(GENESIS);
        vm.expectRevert(MewsArt.GenerationLocked.selector);
        mews.generate(selected);

        _mintAlice(1);
        bytes32 existingSeed = mews.tokenSeed(3);
        assertEq(abi.encode(mews.generate(GENESIS)), abi.encode(renderer.generate(GENESIS)));
        MewsRenderer.TokenData memory custom = mews.generate(selected);
        assertEq(abi.encode(custom.traits), abi.encode(selected));
        assertEq(abi.encode(custom.colors), abi.encode(renderer.generate(GENESIS).colors));
        assertEq(custom.seed, renderer.visualHash(custom.traits, custom.colors));
        assertEq(mews.totalSupply(), 500);
        assertEq(mews.tokenSeed(3), existingSeed);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.ownerOf(501);

        _mintAlice(500);
        mews.generate(GENESIS);
        mews.generate(selected);
        assertEq(mews.totalSupply(), 1000);
    }

    function testGenerationFollowsCurrentMewsOwnership() public {
        vm.prank(SEA_DROP);
        mews.mintSeaDrop(ALICE, 498);
        MewsRenderer.Traits memory selected = renderer.traits(GENESIS);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(GENESIS);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(selected);

        vm.prank(ALICE);
        mews.transferFrom(ALICE, BOB, 3);
        vm.prank(BOB);
        mews.generate(GENESIS);
        vm.prank(BOB);
        mews.generate(selected);
        vm.prank(BOB);
        mews.transferFrom(BOB, ALICE, 3);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(GENESIS);
    }

    function testSelectedTraitsRejectInvalidPalettesAndHappyCollars() public {
        vm.prank(SEA_DROP);
        mews.mintSeaDrop(ALICE, 498);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, address(this), 3);
        MewsRenderer.Traits memory selected =
            MewsRenderer.Traits(MewsRenderer.Pose.Loaf, 0, 0, 0, 0, true);
        selected.coat = renderer.COAT_COLORS();
        vm.expectRevert(MewsRenderer.InvalidPaletteIndex.selector);
        mews.generate(selected);
        selected.coat = 0;
        selected.pose = MewsRenderer.Pose.Happy;
        vm.expectRevert(MewsRenderer.InvalidTraits.selector);
        mews.generate(selected);
    }

    function testFullSupplyHasOneThousandUniqueImages() public {
        mews.updatePublicDrop(SEA_DROP, PublicDrop(PRICE, 100, 2000, 1000, 500, true));
        _mintAlice(500);
        vm.prank(BOB);
        seaDrop.mintPublic{value: PRICE * 498}(address(mews), FEE, address(0), 498);
        assertEq(mews.totalSupply(), 1000);
        assertEq(mews.maxSupply(), 1000);
        for (uint256 id = 1; id <= 1000; ++id) {
            bytes32 seed = mews.tokenSeed(id);
            bytes32 image = keccak256(bytes(renderer.render(0, seed)));
            assertFalse(_seenImages[image], "duplicate image");
            _seenImages[image] = true;
            assertEq(abi.encode(mews.tokenData(id)), abi.encode(renderer.generate(seed)));
            if (id == 1 || id == 1000) {
                assertEq(mews.tokenURI(id), renderer.tokenURI(id, seed));
            }
        }
        vm.expectRevert(
            abi.encodeWithSelector(ISeaDrop.MintQuantityExceedsMaxSupply.selector, 1001, 1000)
        );
        _mintAlice(1);
    }
}
