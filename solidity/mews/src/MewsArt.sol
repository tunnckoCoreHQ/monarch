// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ERC721A} from "erc721a/ERC721A.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {MewsRenderer} from "./MewsRenderer.sol";

abstract contract MewsArt is ERC721A, ReentrancyGuard {
    using SafeCastLib for uint256;

    error InvalidMint();
    error SupplyExceeded();
    error GenerationLocked();
    error NotMewsHolder();

    uint256 public constant MAX_SUPPLY = 1000;
    bytes32 public immutable provenanceHash;
    MewsRenderer public immutable renderer;

    // ERC721A's extraData retains the batch's first token ID across transfers.
    mapping(uint256 => address) private _batchMinters;

    constructor(bytes32 genesisSeed, MewsRenderer renderer_) ERC721A("Mews", "MEWS") {
        provenanceHash = genesisSeed;
        renderer = renderer_;
    }

    function mintSeed(address minter, uint256 tokenId) public view returns (bytes32) {
        return renderer.mintSeed(provenanceHash, minter, tokenId);
    }

    function tokenSeed(uint256 tokenId) public view returns (bytes32) {
        return mintSeed(_batchMinters[_ownershipOf(tokenId).extraData], tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        return renderer.tokenURI(tokenId, tokenSeed(tokenId));
    }

    function tokenData(uint256 tokenId) public view returns (MewsRenderer.TokenData memory) {
        return renderer.generate(tokenSeed(tokenId));
    }

    modifier onlyUnlockedHolder() {
        if (_totalMinted() < 500) {
            revert GenerationLocked();
        }
        if (balanceOf(msg.sender) == 0) {
            revert NotMewsHolder();
        }
        _;
    }

    function generate(bytes32 seed)
        public
        view
        onlyUnlockedHolder
        returns (MewsRenderer.TokenData memory)
    {
        return renderer.generate(seed);
    }

    function generate(MewsRenderer.Traits calldata selected)
        public
        view
        onlyUnlockedHolder
        returns (MewsRenderer.TokenData memory)
    {
        return renderer.generate(selected);
    }

    function _mintCats(address minter, uint256 quantity) internal {
        if (quantity == 0) {
            revert InvalidMint();
        }
        if (quantity > MAX_SUPPLY - _totalMinted()) {
            revert SupplyExceeded();
        }
        _batchMinters[_nextTokenId()] = minter;
        _safeMint(minter, quantity);
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function _extraData(address from, address, uint24 previous)
        internal
        view
        override
        returns (uint24)
    {
        if (from == address(0)) {
            return _nextTokenId().toUint24();
        }
        return previous;
    }
}
