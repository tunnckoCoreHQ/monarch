// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {DropToken} from "../src/DropToken.sol";
import {Subdrop} from "../src/Subdrop.sol";
import {
    CANNOT_UNWRAP,
    INameWrapper,
    PARENT_CANNOT_CONTROL
} from "../src/interfaces/INameWrapper.sol";

interface IBaseRegistrar {
    function ownerOf(uint256 tokenId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
}

interface IWrapper is INameWrapper {
    function wrapETH2LD(
        string calldata label,
        address wrappedOwner,
        uint16 ownerControlledFuses,
        address resolver
    ) external returns (uint64 expires);
    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node);
    function setApprovalForAll(address operator, bool approved) external;
    function names(bytes32 node) external view returns (bytes memory);
}

interface IRegistry {
    function owner(bytes32 node) external view returns (address);
    function resolver(bytes32 node) external view returns (address);
}

interface IPublicResolver {
    function addr(bytes32 node) external view returns (address payable);
}

/// @dev Runs against the real ENS contracts on a pinned mainnet fork. Set MAINNET_RPC_URL to
/// enable it; the suite skips without one so CI stays offline.
contract SubdropForkTest is Test {
    uint256 internal constant BLOCK = 25_947_779;
    address internal constant NAME_WRAPPER = 0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401;
    address internal constant REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address internal constant BASE_REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
    address internal constant PUBLIC_RESOLVER = 0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63;
    bytes32 internal constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;
    string internal constant LABEL = "vitalik";
    uint96 internal constant PRICE = 0.001 ether;
    uint96 internal constant REWARD = 100e18;

    IWrapper internal nameWrapper = IWrapper(NAME_WRAPPER);
    IRegistry internal registry = IRegistry(REGISTRY);
    bytes32 internal parentNode = _subnode(ETH_NODE, LABEL);

    address internal owner;
    address internal treasury = makeAddr("subdrop fork treasury");
    address internal minter = makeAddr("subdrop fork minter");

    bool internal forked;
    Subdrop internal subdrop;
    DropToken internal token;

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function setUp() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            return;
        }
        vm.createSelectFork(rpcUrl, BLOCK);
        forked = true;
        // Mainnet may already have code at derived addresses, which would swallow the fee.
        assertEq(treasury.code.length, 0);
        assertEq(minter.code.length, 0);

        subdrop = new Subdrop(NAME_WRAPPER, PUBLIC_RESOLVER);
        owner = IBaseRegistrar(BASE_REGISTRAR).ownerOf(uint256(keccak256(bytes(LABEL))));
        vm.deal(minter, 1 ether);

        // Owner setup: wrap with CANNOT_UNWRAP, approve Subdrop, launch the token.
        vm.startPrank(owner);
        IBaseRegistrar(BASE_REGISTRAR).setApprovalForAll(NAME_WRAPPER, true);
        nameWrapper.wrapETH2LD(LABEL, owner, uint16(CANNOT_UNWRAP), PUBLIC_RESOLVER);
        nameWrapper.setApprovalForAll(address(subdrop), true);
        token = DropToken(
            subdrop.launch(
                parentNode,
                "Vitalik Drop",
                "VDROP",
                1_000_000e18,
                Subdrop.DropConfig({
                    token: address(0),
                    feeRecipient: treasury,
                    price: PRICE,
                    reward: REWARD,
                    fuses: subdrop.DEFAULT_FUSES(),
                    maxMints: 0
                })
            )
        );
        vm.stopPrank();
    }

    function test_MintAgainstRealNameWrapper() public onlyFork {
        vm.prank(minter);
        bytes32 node = subdrop.mint{value: PRICE}(parentNode, "dan");

        (address nodeOwner, uint32 fuses, uint64 expiry) = nameWrapper.getData(uint256(node));
        (,, uint64 parentExpiry) = nameWrapper.getData(uint256(parentNode));
        assertEq(nodeOwner, minter);
        assertEq(
            fuses & (PARENT_CANNOT_CONTROL | CANNOT_UNWRAP), PARENT_CANNOT_CONTROL | CANNOT_UNWRAP
        );
        assertEq(expiry, parentExpiry);
        assertEq(nameWrapper.names(node), hex"0364616e07766974616c696b0365746800");

        assertEq(registry.owner(node), NAME_WRAPPER);
        assertEq(registry.resolver(node), PUBLIC_RESOLVER);
        assertEq(IPublicResolver(PUBLIC_RESOLVER).addr(node), minter);

        assertEq(token.balanceOf(minter), REWARD);
        assertEq(token.balanceOf(owner), 1_000_000e18 - REWARD);
        assertEq(treasury.balance, PRICE);
        assertEq(subdrop.remaining(parentNode), 9999);
    }

    function test_RevertWhen_ParentReclaimsMintedSubname() public onlyFork {
        vm.prank(minter);
        bytes32 node = subdrop.mint{value: PRICE}(parentNode, "dan");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("OperationProhibited(bytes32)", node));
        nameWrapper.setSubnodeOwner(parentNode, "dan", owner, 0, 0);

        vm.prank(minter);
        vm.expectRevert(Subdrop.LabelTaken.selector);
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function test_RevertWhen_OperatorApprovalRevoked() public onlyFork {
        vm.prank(owner);
        nameWrapper.setApprovalForAll(address(subdrop), false);

        vm.prank(minter);
        vm.expectRevert(
            abi.encodeWithSignature("Unauthorised(bytes32,address)", parentNode, address(subdrop))
        );
        subdrop.mint{value: PRICE}(parentNode, "dan");
    }

    function _subnode(bytes32 parentNode_, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode_, keccak256(bytes(label))));
    }
}
