// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {NekoRenderer} from "./NekoRenderer.sol";

/// @title Neko PFP Generator
/// @notice Canonical deterministic raw-trait, SVG, and ERC-721 metadata generation.
///         Public trait generation, mutation, validation, fusion, and rendering API.
contract NekoGenerator is NekoRenderer {
    uint256 private constant PRIMARY_COLOR_QUOTA = 96;
    uint256 private constant MAX_SEED_SAMPLING_ATTEMPTS = 512;
    uint8 private constant NON_QUOTA_CLASS = 0;
    uint8 private constant BLACK_CLASS = 1;
    uint8 private constant WHITE_CLASS = 2;
    uint8 private constant BLACK_BODY_INDEX = 16;
    uint8 private constant WHITE_BODY_INDEX = 17;
    bytes32 private constant CLASS_PERMUTATION_DOMAIN =
        keccak256("NekoPFPSeaDrop.classPermutation.v1");
    bytes32 private constant TOKEN_SEED_DOMAIN = keccak256("NekoPFPSeaDrop.tokenSeed.v1");
    bytes32 private constant SEED_RETRY_DOMAIN = keccak256("NekoPFPSeaDrop.seedRetry.v1");

    function deriveTokenSeed(bytes32 genesisSeed, uint256 tokenId)
        external
        pure
        override
        returns (uint256)
    {
        if (tokenId == 0 || tokenId > MAX_FUSION_MASS) {
            revert InvalidTokenId();
        }
        return _sampleTokenSeed(genesisSeed, tokenId);
    }

    function generate(uint256 seed) external pure override returns (TokenData memory data) {
        data.traits = deriveRawTraits(seed);
        data.slopTier = _slopTier(data.traits);
        data.fusionMass = 1;
    }

    function generate(RawTraits calldata traits)
        external
        pure
        override
        returns (TokenData memory data)
    {
        return resolveTokenData(traits, 1);
    }

    // ------------------------------------------------------------------
    // Traits
    // ------------------------------------------------------------------

    function deriveRawTraits(uint256 seed) public pure override returns (RawTraits memory traits) {
        (bool matrix, bool invisible, uint256 skyIndex, uint256 bodyIndex) =
            _generationProfile(seed);
        traits.sky = uint8(skyIndex);
        traits.body = uint8(bodyIndex);
        traits.matrix = matrix;
        traits.invisible = invisible;

        if (matrix) {
            traits = _deriveMatrixTraits(seed, bodyIndex, traits);
        } else if (invisible) {
            traits = _deriveInvisibleTraits(seed, skyIndex, traits);
        } else {
            traits = _deriveVisibleTraits(seed, skyIndex, bodyIndex, traits);
        }

        traits.toy = uint8(_roll(seed, TOY, TOY_COUNT));
        return _normalize(traits);
    }

    function resolveTokenData(RawTraits calldata traits, uint256 fusionMass)
        public
        pure
        override
        returns (TokenData memory data)
    {
        _validateRawTraits(traits);
        if (fusionMass == 0 || fusionMass > MAX_FUSION_MASS) {
            revert InvalidFusionMass();
        }
        data.traits = traits;
        data.slopTier = _slopTier(traits);
        data.fusionMass = fusionMass;
    }

    function combineRawTraits(
        RawTraits calldata survivor,
        RawTraits calldata consumed,
        uint16 consumedPartsMask
    ) external pure override returns (RawTraits memory combined) {
        _validateRawTraits(survivor);
        _validateRawTraits(consumed);
        if (consumedPartsMask == 0 || consumedPartsMask & ~ALL_PARTS_MASK != 0) {
            revert InvalidMutationSelectionMask();
        }

        combined = survivor;
        if (consumedPartsMask & 0x0001 != 0) {
            combined.sky = consumed.sky;
            combined.matrix = consumed.matrix;
            combined.invisible = consumed.invisible;
        }
        if (consumedPartsMask & 0x0002 != 0) combined.head = consumed.head;
        if (consumedPartsMask & 0x0004 != 0) combined.face = consumed.face;
        if (consumedPartsMask & 0x0008 != 0) combined.body = consumed.body;
        if (consumedPartsMask & 0x0010 != 0) combined.tail = consumed.tail;
        for (uint8 i; i < 4; ++i) {
            if (consumedPartsMask & (uint16(0x0020) << i) != 0) {
                combined.legs[i] = consumed.legs[i];
            }
        }
        for (uint8 i; i < 2; ++i) {
            if (consumedPartsMask & (uint16(0x0200) << i) != 0) {
                combined.eyes[i] = consumed.eyes[i];
            }
        }
        if (consumedPartsMask & 0x0800 != 0) combined.mouth = consumed.mouth;
        if (consumedPartsMask & 0x1000 != 0) combined.toy = consumed.toy;
        return _normalize(combined);
    }

    function generationProfile(uint256 seed)
        external
        pure
        override
        returns (bool matrix, bool invisible, uint8 bodyIndex)
    {
        uint256 selectedBodyIndex;
        (matrix, invisible,, selectedBodyIndex) = _generationProfile(seed);
        bodyIndex = uint8(selectedBodyIndex);
    }

    function catSignature(RawTraits calldata traits) external pure override returns (bytes32) {
        _validateRawTraits(traits);
        return keccak256(
            abi.encode(
                CAT_SIGNATURE_DOMAIN,
                traits.matrix,
                traits.sky,
                traits.head,
                traits.face,
                traits.body,
                traits.tail,
                traits.legs,
                traits.eyes,
                traits.mouth
            )
        );
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function generateSVG(TokenData calldata data) public pure override returns (string memory) {
        _validateTokenData(data);
        return _renderSVG(data.traits, data.fusionMass);
    }

    function generateImageURI(TokenData calldata data)
        public
        pure
        override
        returns (string memory uri, bytes32 contentHash)
    {
        _validateTokenData(data);
        string memory svg = _renderSVG(data.traits, data.fusionMass);
        uri = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
        contentHash = keccak256(bytes(uri));
    }

    function generateUnrevealedImageURI() public pure override returns (string memory) {
        RawTraits memory traits;
        traits.sky = UNREVEALED_SKY;
        traits.head = UNREVEALED_BODY;
        traits.face = UNREVEALED_FACE;
        traits.body = UNREVEALED_BODY;
        traits.tail = UNREVEALED_BODY;
        for (uint256 i; i < 4; ++i) {
            traits.legs[i] = UNREVEALED_BODY;
        }
        traits.eyes[0] = UNREVEALED_FACE;
        traits.eyes[1] = UNREVEALED_FACE;
        traits.mouth = UNREVEALED_FACE;

        string memory svg = string.concat(
            '<svg viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" image-rendering="pixelated">',
            _renderBackground(traits),
            _renderBody(traits),
            _renderLegs(traits),
            _renderFace(traits),
            _renderHead(traits),
            "</svg>"
        );
        return string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
    }

    function generateUnrevealedTokenURI(uint256 tokenId)
        external
        pure
        override
        returns (string memory)
    {
        string memory imageURI = generateUnrevealedImageURI();
        string memory json = string.concat(
            '{"name":"0xNeko PFP #',
            LibString.toString(tokenId),
            ' - Unrevealed","description":"Art reveals after mint completion. Fully on-chain, pixel-perfect generative 0xNeko SVG art.","image":"',
            imageURI,
            '","attributes":[{"trait_type":"Status","value":"Unrevealed"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function generateTokenURI(uint256 tokenId, TokenData calldata data)
        public
        pure
        override
        returns (string memory)
    {
        (string memory imageURI,) = generateImageURI(data);
        string memory identity = string.concat(
            '{"name":"0xNeko PFP #',
            LibString.toString(tokenId),
            '","description":"Fully on-chain generative 0xNeko PFP.","image":"',
            imageURI,
            '","attributes":'
        );
        string memory json = string.concat(identity, _attributes(data), "}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _sampleTokenSeed(bytes32 seed, uint256 tokenId) internal pure returns (uint256) {
        uint8 desiredClass = _desiredProfileClass(seed, tokenId);

        for (uint256 attempt; attempt < MAX_SEED_SAMPLING_ATTEMPTS; ++attempt) {
            bytes32 domain = attempt == 0 ? TOKEN_SEED_DOMAIN : SEED_RETRY_DOMAIN;
            uint256 candidate = uint256(keccak256(abi.encode(domain, seed, tokenId, attempt)));
            if (_profileMatches(candidate, desiredClass)) {
                return candidate;
            }
        }

        revert SeedSamplingExhausted(tokenId, desiredClass);
    }

    function _desiredProfileClass(bytes32 seed, uint256 tokenId) private pure returns (uint8) {
        uint256 position = _classPermutationPosition(seed, tokenId);
        if (position < PRIMARY_COLOR_QUOTA) {
            return BLACK_CLASS;
        }
        if (position < PRIMARY_COLOR_QUOTA * 2) {
            return WHITE_CLASS;
        }

        return NON_QUOTA_CLASS;
    }

    /// @dev Cycle-walking a keyed 13-bit Feistel permutation yields an exact permutation of 0..4662.
    function _classPermutationPosition(bytes32 seed, uint256 tokenId)
        private
        pure
        returns (uint256 position)
    {
        position = tokenId - 1;
        do {
            position = _permute13(seed, position);
        } while (position >= MAX_FUSION_MASS);
    }

    function _permute13(bytes32 seed, uint256 value) private pure returns (uint256) {
        uint256 left = value >> 7;
        uint256 right = value & 0x7f;
        for (uint256 round; round < 4; ++round) {
            left ^= uint256(keccak256(abi.encode(CLASS_PERMUTATION_DOMAIN, seed, round * 2, right)))
            & 0x3f;
            right ^= uint256(
                keccak256(abi.encode(CLASS_PERMUTATION_DOMAIN, seed, round * 2 + 1, left))
            ) & 0x7f;
        }

        return (left << 7) | right;
    }

    function _profileMatches(uint256 seed, uint8 desiredClass) private pure returns (bool) {
        (bool matrix, bool invisible,, uint256 bodyIndex) = _generationProfile(seed);

        if (matrix && bodyIndex == BLACK_BODY_INDEX) {
            return false;
        }
        if (invisible) {
            return desiredClass == NON_QUOTA_CLASS;
        }
        if (bodyIndex == BLACK_BODY_INDEX) {
            return desiredClass == BLACK_CLASS;
        }
        if (bodyIndex == WHITE_BODY_INDEX) {
            return desiredClass == WHITE_CLASS;
        }

        return desiredClass == NON_QUOTA_CLASS;
    }
}
