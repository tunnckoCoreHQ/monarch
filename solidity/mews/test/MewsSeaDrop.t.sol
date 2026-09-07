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
    PublicDrop,
    MultiConfigureStruct,
    AllowListData,
    MintParams,
    TokenGatedDropStage,
    SignedMintValidationParams
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
    event DropURIUpdated(address indexed nftContract, string newDropURI);
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
        MultiConfigureStruct memory config;
        config.seaDropImpl = SEA_DROP;
        config.creatorPayoutAddress = PAYOUT;
        config.allowedFeeRecipients = new address[](1);
        config.allowedFeeRecipients[0] = FEE;
        config.publicDrop = PublicDrop(PRICE, 100, 2000, 5, 500, true);
        mews.multiConfigure(config);
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

    function _configurePublicDrop(PublicDrop memory stage) internal {
        MultiConfigureStruct memory config;
        config.seaDropImpl = SEA_DROP;
        config.publicDrop = stage;
        mews.multiConfigure(config);
    }

    function testConstructorMintsFullCreatorAllocation() public view {
        assertEq(mews.owner(), address(this));
        assertEq(mews.totalSupply(), 20);
        assertEq(mews.ownerOf(1), 0x9D9db340778139774cF73DFB7Bf27498Fa67978F);
        assertEq(mews.ownerOf(5), 0x9D9db340778139774cF73DFB7Bf27498Fa67978F);
        assertEq(mews.ownerOf(6), 0x6C22d03544609Db5128736706d90D66fC7f45388);
        assertEq(mews.ownerOf(20), 0x6C22d03544609Db5128736706d90D66fC7f45388);
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
        assertEq(mews.ownerOf(21), ALICE);
        assertEq(mews.ownerOf(23), ALICE);
        assertEq(mews.tokenSeed(21), mews.mintSeed(ALICE, 21));
        assertEq(mews.tokenData(21).seed, mews.tokenSeed(21));
        assertEq(mews.tokenURI(21), renderer.tokenURI(21, mews.tokenSeed(21)));
        assertEq(PAYOUT.balance, uint256(PRICE) * 3 * 95 / 100);
        assertEq(FEE.balance, uint256(PRICE) * 3 * 5 / 100);
    }

    function testConstructorDoesNotCallRecipientCode() public {
        address first = 0x9D9db340778139774cF73DFB7Bf27498Fa67978F;
        address second = 0x6C22d03544609Db5128736706d90D66fC7f45388;
        vm.etch(first, hex"60006000fd");
        vm.etch(second, hex"60006000fd");
        MewsSeaDrop fresh = _deploy(GENESIS);
        assertEq(fresh.balanceOf(first), 5);
        assertEq(fresh.balanceOf(second), 15);
        assertEq(fresh.tokenSeed(1), fresh.mintSeed(first, 1));
        assertEq(fresh.tokenSeed(6), fresh.mintSeed(second, 6));
    }

    function testConstructorEmitsSeaDropDiscoveryEvents() public {
        address[] memory allowed = new address[](1);
        allowed[0] = SEA_DROP;
        vm.expectEmit(false, false, false, true);
        emit MewsSeaDrop.AllowedSeaDropUpdated(allowed);
        vm.expectEmit(false, false, false, true);
        emit MewsSeaDrop.SeaDropTokenDeployed();
        _deploy(GENESIS);
    }

    function testStudioSelectorConfiguresSupportedFieldsAndSkipsFixedFields() public {
        mews = _deploy(GENESIS);
        assertEq(MewsSeaDrop.multiConfigure.selector, bytes4(0x911f456b));
        MintParams memory allowlist = MintParams(0, 2, 100, 2000, 1, 1000, 1000, true);
        MultiConfigureStruct memory config;
        config.seaDropImpl = SEA_DROP;
        config.maxSupply = 9999;
        config.baseURI = "ipfs://ignored";
        config.provenanceHash = bytes32(uint256(99));
        config.contractURI = "ipfs://studio-collection";
        config.dropURI = "ipfs://studio-drop";
        config.publicDrop = PublicDrop(0.000_42 ether, 100, 2000, 10, 1000, true);
        config.creatorPayoutAddress = PAYOUT;
        config.allowListData = AllowListData(
            keccak256(abi.encode(ALICE, allowlist)), new string[](0), "ipfs://studio-allowlist"
        );
        config.allowedFeeRecipients = new address[](1);
        config.allowedFeeRecipients[0] = FEE;
        config.allowedPayers = new address[](1);
        config.allowedPayers[0] = BOB;
        // Unsupported fields are ignored, including mismatched array lengths.
        config.tokenGatedAllowedNftTokens = new address[](2);
        config.tokenGatedDropStages = new TokenGatedDropStage[](1);
        config.disallowedTokenGatedAllowedNftTokens = new address[](1);
        config.signers = new address[](2);
        config.signedMintValidationParams = new SignedMintValidationParams[](1);
        config.disallowedSigners = new address[](1);

        vm.expectEmit(false, false, false, true, address(mews));
        emit MewsSeaDrop.ContractURIUpdated(config.contractURI);
        vm.expectEmit(true, false, false, true, SEA_DROP);
        emit DropURIUpdated(address(mews), config.dropURI);
        (bool success,) = address(mews).call(abi.encodeWithSelector(bytes4(0x911f456b), config));
        assertTrue(success, "Studio selector call failed");
        assertEq(mews.maxSupply(), 1000);
        assertEq(mews.provenanceHash(), GENESIS);
        assertEq(mews.contractURI(), config.contractURI);
        assertEq(abi.encode(seaDrop.getPublicDrop(address(mews))), abi.encode(config.publicDrop));
        assertEq(seaDrop.getCreatorPayoutAddress(address(mews)), PAYOUT);
        assertEq(seaDrop.getAllowListMerkleRoot(address(mews)), config.allowListData.merkleRoot);
        assertTrue(seaDrop.getFeeRecipientIsAllowed(address(mews), FEE));
        assertTrue(seaDrop.getPayerIsAllowed(address(mews), BOB));

        uint256 payoutBefore = PAYOUT.balance;
        uint256 feeBefore = FEE.balance;
        vm.prank(BOB);
        seaDrop.mintPublic{value: 0.0042 ether}(address(mews), FEE, address(0), 10);
        assertEq(mews.balanceOf(BOB), 10);
        assertEq(PAYOUT.balance - payoutBefore, 0.003_78 ether);
        assertEq(FEE.balance - feeBefore, 0.000_42 ether);
        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(ISeaDrop.MintQuantityExceedsMaxMintedPerWallet.selector, 11, 10)
        );
        seaDrop.mintPublic{value: 0.000_42 ether}(address(mews), FEE, address(0), 1);
        vm.prank(ALICE);
        seaDrop.mintAllowList(address(mews), FEE, address(0), 1, allowlist, new bytes32[](0));
        assertEq(mews.balanceOf(ALICE), 1);
    }

    function testEmptyConfigurationPreservesExistingSettings() public {
        mews.setContractURI("ipfs://keep-profile");
        PublicDrop memory before = seaDrop.getPublicDrop(address(mews));
        MultiConfigureStruct memory config;
        config.seaDropImpl = SEA_DROP;
        mews.multiConfigure(config);
        assertEq(mews.contractURI(), "ipfs://keep-profile");
        assertEq(abi.encode(seaDrop.getPublicDrop(address(mews))), abi.encode(before));
        assertEq(seaDrop.getCreatorPayoutAddress(address(mews)), PAYOUT);
        assertTrue(seaDrop.getFeeRecipientIsAllowed(address(mews), FEE));
    }

    function testMultiConfigureAddsAndRemovesPayersAndFeeRecipients() public {
        MultiConfigureStruct memory config;
        config.seaDropImpl = SEA_DROP;
        config.allowedPayers = new address[](1);
        config.allowedPayers[0] = BOB;
        mews.multiConfigure(config);
        vm.prank(BOB);
        seaDrop.mintPublic{value: PRICE}(address(mews), FEE, ALICE, 1);
        assertEq(mews.ownerOf(21), ALICE);
        config.allowedPayers = new address[](0);
        config.disallowedPayers = new address[](1);
        config.disallowedPayers[0] = BOB;
        config.disallowedFeeRecipients = new address[](1);
        config.disallowedFeeRecipients[0] = FEE;
        mews.multiConfigure(config);
        assertFalse(seaDrop.getPayerIsAllowed(address(mews), BOB));
        assertFalse(seaDrop.getFeeRecipientIsAllowed(address(mews), FEE));
        vm.prank(BOB);
        vm.expectRevert(ISeaDrop.PayerNotAllowed.selector);
        seaDrop.mintPublic{value: PRICE}(address(mews), FEE, ALICE, 1);
        vm.expectRevert(ISeaDrop.FeeRecipientNotAllowed.selector);
        _mintAlice(1);
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
        assertEq(fresh.totalSupply(), 20);
        _mintAlice(3);
        assertEq(mews.totalSupply(), 23);
        assertEq(mews.tokenData(23).seed, mews.mintSeed(ALICE, 23));
    }

    function testOriginalMintersSurviveTransfersAndBatchBoundaries() public {
        _mintAlice(3);
        vm.prank(BOB);
        seaDrop.mintPublic{value: PRICE * 2}(address(mews), FEE, address(0), 2);
        string memory original = mews.tokenURI(22);
        bytes memory raw = abi.encode(mews.tokenData(22));
        vm.startPrank(ALICE);
        mews.transferFrom(ALICE, BOB, 22);
        mews.transferFrom(ALICE, BOB, 21);
        vm.stopPrank();
        vm.prank(BOB);
        mews.transferFrom(BOB, ALICE, 24);
        for (uint256 id = 21; id <= 23; ++id) {
            assertEq(mews.tokenSeed(id), mews.mintSeed(ALICE, id));
        }
        assertEq(mews.tokenSeed(24), mews.mintSeed(BOB, 24));
        assertEq(mews.tokenSeed(25), mews.mintSeed(BOB, 25));
        assertEq(mews.tokenURI(22), original);
        assertEq(abi.encode(mews.tokenData(22)), raw);
    }

    function testSeaDropEnforcesWalletCapAfterTransfers() public {
        _mintAlice(3);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, BOB, 21);
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
        _configurePublicDrop(PublicDrop(0, 100, 2000, 5, 0, false));
        MultiConfigureStruct memory config;
        config.seaDropImpl = BOB;
        config.creatorPayoutAddress = PAYOUT;
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        mews.multiConfigure(config);
        config.seaDropImpl = SEA_DROP;
        config.creatorPayoutAddress = BOB;
        mews.multiConfigure(config);
        assertEq(seaDrop.getCreatorPayoutAddress(address(mews)), BOB);
    }

    function testOwnerCanUpdateRoyalties() public {
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
        emit MewsSeaDrop.ContractURIUpdated("ipfs://updated-mews");
        mews.setContractURI("ipfs://updated-mews");
        assertEq(mews.contractURI(), "ipfs://updated-mews");
    }

    function testNonexistentTokensHaveNoSeedOrData() public {
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenSeed(21);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenData(21);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.tokenURI(0);
    }

    function testReceiverCannotReenterMint() public {
        SeaDropReceiver receiver = new SeaDropReceiver();
        vm.deal(address(this), PRICE);
        receiver.mint{value: PRICE}(mews, seaDrop, FEE);
        assertEq(receiver.rejection(), abi.encodeWithSelector(ReentrancyGuard.Reentrancy.selector));
        assertEq(receiver.observedMinted(), 1);
        assertEq(receiver.observedSupply(), 21);
        assertEq(receiver.observedSeed(), mews.mintSeed(address(receiver), 21));
    }

    function testRejectedReceiverRollsBackPaymentAndMint() public {
        RejectingReceiver receiver = new RejectingReceiver();
        vm.deal(address(receiver), PRICE);
        vm.prank(address(receiver));
        vm.expectRevert(IERC721A.TransferToNonERC721ReceiverImplementer.selector);
        seaDrop.mintPublic{value: PRICE}(address(mews), FEE, address(0), 1);
        assertEq(address(receiver).balance, PRICE);
        assertEq(PAYOUT.balance, 0);
        assertEq(mews.totalSupply(), 20);
        _mintAlice(1);
        assertEq(mews.tokenSeed(21), mews.mintSeed(ALICE, 21));
    }

    function testGenerationUnlocksAtFiveHundredAndDoesNotMint() public {
        _configurePublicDrop(PublicDrop(PRICE, 100, 2000, 1000, 500, true));
        _mintAlice(479);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, address(this), 21);
        MewsRenderer.Traits memory selected = renderer.traits(GENESIS);
        vm.expectRevert(MewsArt.GenerationLocked.selector);
        mews.generate(GENESIS);
        vm.expectRevert(MewsArt.GenerationLocked.selector);
        mews.generate(selected);

        _mintAlice(1);
        bytes32 existingSeed = mews.tokenSeed(21);
        assertEq(abi.encode(mews.generate(GENESIS)), abi.encode(renderer.generate(GENESIS)));
        MewsRenderer.TokenData memory custom = mews.generate(selected);
        assertEq(abi.encode(custom.traits), abi.encode(selected));
        assertEq(abi.encode(custom.colors), abi.encode(renderer.generate(GENESIS).colors));
        assertEq(custom.seed, renderer.visualHash(custom.traits, custom.colors));
        assertEq(mews.totalSupply(), 500);
        assertEq(mews.tokenSeed(21), existingSeed);
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        mews.ownerOf(501);

        _mintAlice(500);
        mews.generate(GENESIS);
        mews.generate(selected);
        assertEq(mews.totalSupply(), 1000);
    }

    function testGenerationFollowsCurrentMewsOwnership() public {
        vm.prank(SEA_DROP);
        mews.mintSeaDrop(ALICE, 480);
        MewsRenderer.Traits memory selected = renderer.traits(GENESIS);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(GENESIS);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(selected);

        vm.prank(ALICE);
        mews.transferFrom(ALICE, BOB, 21);
        vm.prank(BOB);
        mews.generate(GENESIS);
        vm.prank(BOB);
        mews.generate(selected);
        vm.prank(BOB);
        mews.transferFrom(BOB, ALICE, 21);
        vm.prank(BOB);
        vm.expectRevert(MewsArt.NotMewsHolder.selector);
        mews.generate(GENESIS);
    }

    function testSelectedTraitsRejectInvalidPalettesAndHappyCollars() public {
        vm.prank(SEA_DROP);
        mews.mintSeaDrop(ALICE, 480);
        vm.prank(ALICE);
        mews.transferFrom(ALICE, address(this), 21);
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
        _configurePublicDrop(PublicDrop(PRICE, 100, 2000, 1000, 500, true));
        _mintAlice(500);
        vm.prank(BOB);
        seaDrop.mintPublic{value: PRICE * 480}(address(mews), FEE, address(0), 480);
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
