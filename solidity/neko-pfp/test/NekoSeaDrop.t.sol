// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {NekoSeaDrop} from "../src/NekoSeaDrop.sol";
import {NekoRenderer} from "../src/NekoRenderer.sol";
import {
    ISeaDrop,
    IERC2981,
    INonFungibleSeaDropToken,
    ISeaDropTokenContractMetadata,
    PublicDrop,
    MultiConfigureStruct,
    AllowListData,
    MintParams,
    TokenGatedDropStage,
    SignedMintValidationParams
} from "../src/seadrop/SeaDropInterfaces.sol";

contract NekoSeaDropTest is Test {
    event DropURIUpdated(address indexed nftContract, string newDropURI);

    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant PAYOUT = address(0xCAFE);
    address internal constant FEE = address(0xFEE);
    bytes32 internal constant GENESIS = keccak256("Neko SeaDrop integration");
    uint256 internal constant SUPPLY = 4663;
    uint80 internal constant PRICE = 0.001 ether;
    ISeaDrop internal seaDrop = ISeaDrop(SEA_DROP);
    NekoRenderer internal renderer;
    NekoSeaDrop internal neko;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1000);
        // The same deployed Base SeaDrop runtime used by Mews, at block 50965136.
        string memory encoded = vm.readFile("test/fixtures/SeaDrop.hex");
        bytes memory runtime = vm.parseBytes(LibString.slice(encoded, 0, bytes(encoded).length - 1));
        assertEq(
            keccak256(runtime), 0x2151e8d092f04e5cf00576bf5e6b92a0fc15b0013dc8c08b68934048d39ac1fc
        );
        vm.etch(SEA_DROP, runtime);
        vm.store(SEA_DROP, bytes32(0), bytes32(uint256(1)));
        renderer = new NekoRenderer();
        neko = new NekoSeaDrop(_commitment(), renderer, seaDrop);
        vm.deal(ALICE, 10 ether);
        vm.deal(BOB, 10 ether);
    }

    function _commitment() internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("NekoPFPSeaDrop.genesisSeedCommitment.v1"), GENESIS));
    }

    function _config() internal pure returns (MultiConfigureStruct memory config) {
        config.seaDropImpl = SEA_DROP;
        config.maxSupply = SUPPLY;
        config.creatorPayoutAddress = PAYOUT;
        config.allowedFeeRecipients = new address[](1);
        config.allowedFeeRecipients[0] = FEE;
        config.publicDrop = PublicDrop(PRICE, 100, 2000, 10, 1000, true);
    }

    function testInterfaceIdsMatchSeaDropAndStudio() public view {
        assertEq(type(INonFungibleSeaDropToken).interfaceId, bytes4(0x1890fe8e));
        assertEq(NekoSeaDrop.multiConfigure.selector, bytes4(0x911f456b));
        assertTrue(neko.supportsInterface(type(INonFungibleSeaDropToken).interfaceId));
        assertTrue(neko.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(neko.supportsInterface(0x01ffc9a7));
        assertTrue(neko.supportsInterface(0x80ac58cd));
        assertTrue(neko.supportsInterface(0x5b5e139f));
        assertTrue(neko.supportsInterface(0x49064906));
        assertFalse(neko.supportsInterface(0xffffffff));
        assertLe(address(neko).code.length, 24_576);
        assertLe(address(renderer).code.length, 24_576);
    }

    function testConstructorEmitsSeaDropDiscoveryEvents() public {
        address[] memory allowed = new address[](1);
        allowed[0] = SEA_DROP;
        vm.expectEmit(false, false, false, true);
        emit NekoSeaDrop.AllowedSeaDropUpdated(allowed);
        vm.expectEmit(false, false, false, true);
        emit NekoSeaDrop.SeaDropTokenDeployed();
        vm.expectEmit(false, false, false, true);
        emit ISeaDropTokenContractMetadata.MaxSupplyUpdated(SUPPLY);
        new NekoSeaDrop(_commitment(), renderer, seaDrop);
    }

    function testStudioConfiguresRealSeaDropAndBothMintStages() public {
        MultiConfigureStruct memory config = _config();
        config.contractURI = "ipfs://collection";
        config.dropURI = "ipfs://drop";
        MintParams memory allowlist = MintParams(0, 3, 100, 2000, 1, SUPPLY, 1000, true);
        config.allowListData = AllowListData(
            keccak256(abi.encode(ALICE, allowlist)), new string[](0), "ipfs://allowlist"
        );
        config.allowedPayers = new address[](1);
        config.allowedPayers[0] = BOB;

        vm.expectEmit(false, false, false, true, address(neko));
        emit ISeaDropTokenContractMetadata.MaxSupplyUpdated(SUPPLY);
        vm.expectEmit(true, false, false, true, SEA_DROP);
        emit DropURIUpdated(address(neko), config.dropURI);
        (bool success,) = address(neko).call(abi.encodeWithSelector(bytes4(0x911f456b), config));
        assertTrue(success);
        assertEq(abi.encode(seaDrop.getPublicDrop(address(neko))), abi.encode(config.publicDrop));
        assertEq(seaDrop.getCreatorPayoutAddress(address(neko)), PAYOUT);
        assertEq(seaDrop.getAllowListMerkleRoot(address(neko)), config.allowListData.merkleRoot);
        assertTrue(seaDrop.getFeeRecipientIsAllowed(address(neko), FEE));
        assertTrue(seaDrop.getPayerIsAllowed(address(neko), BOB));
        assertEq(neko.contractURI(), config.contractURI);

        vm.prank(ALICE);
        seaDrop.mintAllowList(address(neko), FEE, address(0), 3, allowlist, new bytes32[](0));
        vm.prank(BOB);
        seaDrop.mintPublic{value: PRICE * 7}(address(neko), FEE, ALICE, 7);
        assertEq(neko.balanceOf(ALICE), 10);
        assertEq(PAYOUT.balance, PRICE * 7 * 9 / 10);
        assertEq(FEE.balance, PRICE * 7 / 10);
        string memory placeholder = string(Base64.decode(LibString.slice(neko.tokenURI(1), 29)));
        assertTrue(LibString.contains(placeholder, '"name":"0xNeko PFP #1 - Unrevealed"'));
        assertTrue(LibString.contains(placeholder, '"image":"data:image/svg+xml;base64,'));
        vm.prank(ALICE);
        neko.transferFrom(ALICE, BOB, 1);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ISeaDrop.MintQuantityExceedsMaxMintedPerWallet.selector, 11, 10)
        );
        seaDrop.mintPublic{value: PRICE}(address(neko), FEE, address(0), 1);
    }

    function testEmptyConfigPreservesProfileAndDropSettings() public {
        neko.multiConfigure(_config());
        neko.setContractURI("ipfs://custom");
        PublicDrop memory stage = seaDrop.getPublicDrop(address(neko));
        MultiConfigureStruct memory config;
        config.seaDropImpl = SEA_DROP;
        config.baseURI = "ipfs://ignored";
        config.provenanceHash = keccak256("ignored");
        config.tokenGatedAllowedNftTokens = new address[](2);
        config.tokenGatedDropStages = new TokenGatedDropStage[](1);
        config.signers = new address[](2);
        config.signedMintValidationParams = new SignedMintValidationParams[](1);
        config.disallowedTokenGatedAllowedNftTokens = new address[](1);
        config.disallowedSigners = new address[](1);

        vm.recordLogs();
        neko.multiConfigure(config);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(neko.contractURI(), "ipfs://custom");
        assertEq(neko.maxSupply(), SUPPLY);
        assertEq(neko.provenanceHash(), _commitment());
        assertEq(abi.encode(seaDrop.getPublicDrop(address(neko))), abi.encode(stage));
        assertEq(seaDrop.getCreatorPayoutAddress(address(neko)), PAYOUT);
        assertTrue(seaDrop.getFeeRecipientIsAllowed(address(neko), FEE));
    }

    function testStudioCanRemoveFeeRecipientsAndPayers() public {
        MultiConfigureStruct memory config = _config();
        config.allowedPayers = new address[](1);
        config.allowedPayers[0] = BOB;
        neko.multiConfigure(config);
        config.allowedFeeRecipients = new address[](0);
        config.allowedPayers = new address[](0);
        config.disallowedFeeRecipients = new address[](1);
        config.disallowedFeeRecipients[0] = FEE;
        config.disallowedPayers = new address[](1);
        config.disallowedPayers[0] = BOB;
        neko.multiConfigure(config);
        assertFalse(seaDrop.getFeeRecipientIsAllowed(address(neko), FEE));
        assertFalse(seaDrop.getPayerIsAllowed(address(neko), BOB));
    }

    function testOwnerCanReannounceSupplyButCannotChangeIt() public {
        vm.expectEmit(false, false, false, true, address(neko));
        emit ISeaDropTokenContractMetadata.MaxSupplyUpdated(SUPPLY);
        neko.setMaxSupply(SUPPLY);
        vm.expectRevert(NekoSeaDrop.FixedMaxSupply.selector);
        neko.setMaxSupply(SUPPLY - 1);
        vm.expectRevert(NekoSeaDrop.FixedMaxSupply.selector);
        neko.setMaxSupply(SUPPLY + 1);
        vm.expectRevert(NekoSeaDrop.FixedMaxSupply.selector);
        neko.setMaxSupply(0);
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.setMaxSupply(SUPPLY);
    }

    function testStudioRejectsInvalidSupplySeaDropAndCaller() public {
        MultiConfigureStruct memory config = _config();
        config.maxSupply = SUPPLY - 1;
        vm.expectRevert(NekoSeaDrop.FixedMaxSupply.selector);
        neko.multiConfigure(config);
        config.maxSupply = SUPPLY + 1;
        vm.expectRevert(NekoSeaDrop.FixedMaxSupply.selector);
        neko.multiConfigure(config);
        config.maxSupply = SUPPLY;
        config.seaDropImpl = BOB;
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        neko.multiConfigure(config);
        config.seaDropImpl = SEA_DROP;
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.multiConfigure(config);
        assertEq(seaDrop.getPublicDrop(address(neko)).startTime, 0);
    }

    function testRealSeaDropSelloutAllowsRevealAndRejectsMoreMints() public {
        MultiConfigureStruct memory config = _config();
        config.publicDrop.maxTotalMintableByWallet = uint16(SUPPLY + 1);
        neko.multiConfigure(config);
        vm.prank(ALICE);
        seaDrop.mintPublic{value: PRICE * SUPPLY}(address(neko), FEE, address(0), SUPPLY);
        neko.reveal(GENESIS);
        assertTrue(neko.revealed());
        assertEq(neko.tokenURI(1), renderer.tokenURI(1, neko.tokenData(1)));
        (uint256 minted, uint256 total, uint256 maximum) = neko.getMintStats(ALICE);
        assertEq(minted, SUPPLY);
        assertEq(total, SUPPLY);
        assertEq(maximum, SUPPLY);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDrop.MintQuantityExceedsMaxSupply.selector, SUPPLY + 1, SUPPLY
            )
        );
        seaDrop.mintPublic{value: PRICE}(address(neko), FEE, address(0), 1);
    }

    function testRoyaltyInfoAndOwnerControls() public {
        ISeaDropTokenContractMetadata.RoyaltyInfo memory info =
            ISeaDropTokenContractMetadata.RoyaltyInfo(BOB, 750);
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.setRoyaltyInfo(info);
        vm.expectEmit(false, false, false, true, address(neko));
        emit NekoSeaDrop.RoyaltyInfoUpdated(BOB, 750);
        neko.setRoyaltyInfo(info);
        (address receiver, uint256 amount) = neko.royaltyInfo(1, 1 ether);
        assertEq(receiver, BOB);
        assertEq(amount, 0.075 ether);
        assertEq(neko.royaltyAddress(), BOB);
        assertEq(neko.royaltyBasisPoints(), 750);
        info.royaltyAddress = address(0);
        vm.expectRevert(ISeaDropTokenContractMetadata.RoyaltyAddressCannotBeZeroAddress.selector);
        neko.setRoyaltyInfo(info);
        info.royaltyAddress = BOB;
        info.royaltyBps = 10_001;
        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDropTokenContractMetadata.InvalidRoyaltyBasisPoints.selector, 10_001
            )
        );
        neko.setRoyaltyInfo(info);
        vm.prank(ALICE);
        vm.expectRevert(Ownable.Unauthorized.selector);
        neko.setContractURI("ipfs://unauthorized");
    }
}
