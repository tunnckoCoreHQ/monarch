// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {INekoGenerator} from "../src/INekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {MockNekoGenerator} from "./mocks/MockNekoGenerator.sol";

contract TestableNekoPFP is NekoPFP {
    constructor(
        address[] memory allowedSeaDrop,
        INekoGenerator generator,
        bytes32 genesisSeedCommitment
    ) NekoPFP("Neko", "NEKO", allowedSeaDrop, generator, genesisSeedCommitment) {}

    function setGenesisSeedForTest(bytes32 seed) external {
        genesisSeed = seed;
        revealed = true;
    }
}

abstract contract NekoTestBase is Test {
    address internal constant SEA_DROP = address(0x5EA);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant INTENDED_SUPPLY = 4663;
    uint256 internal constant PRIMARY_COLOR_QUOTA = 96;
    bytes32 internal constant GENESIS_SEED = keccak256("NekoPFPv3SeaDrop.test.seed");
    bytes32 internal constant GENESIS_SEED_COMMITMENT_DOMAIN =
        keccak256("NekoPFPSeaDrop.genesisSeedCommitment.v1");

    MockNekoGenerator internal generator;
    TestableNekoPFP internal neko;

    function setUp() public virtual {
        generator = new MockNekoGenerator();
        neko = _deploy(generator, _commitment(GENESIS_SEED));
    }

    function _deploy(INekoGenerator generator_, bytes32 commitment)
        internal
        returns (TestableNekoPFP)
    {
        return new TestableNekoPFP(_allowedSeaDrop(), generator_, commitment);
    }

    function _setRevealed() internal {
        neko.setGenesisSeedForTest(GENESIS_SEED);
    }

    function _mint(address recipient, uint256 quantity) internal {
        vm.prank(SEA_DROP);
        neko.mintSeaDrop(recipient, quantity);
    }

    function _allowedSeaDrop() internal pure returns (address[] memory allowedSeaDrop) {
        allowedSeaDrop = new address[](1);
        allowedSeaDrop[0] = SEA_DROP;
    }

    function _commitment(bytes32 seed) internal pure returns (bytes32) {
        return keccak256(abi.encode(GENESIS_SEED_COMMITMENT_DOMAIN, seed));
    }

    function _baseTraits(uint8 body, uint8 toy)
        internal
        pure
        returns (INekoGenerator.RawTraits memory traits)
    {
        traits.sky = body == 0 ? 1 : 0;
        traits.head = body;
        traits.face = body % 13;
        traits.body = body;
        traits.tail = body;
        traits.mouth = traits.face;
        traits.toy = toy;
        for (uint256 i; i < 4; ++i) {
            traits.legs[i] = body;
        }
        for (uint256 i; i < 2; ++i) {
            traits.eyes[i] = traits.face;
        }
    }
}
