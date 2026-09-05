// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {NekoRenderer} from "./NekoRenderer.sol";

/// @title Neko PFP Generator
/// @notice Canonical deterministic raw-trait, SVG, and ERC-721 metadata generation.
///         Public trait generation, mutation, validation, fusion, and rendering API.
contract NekoGenerator is NekoRenderer {
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
        external
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
        _validateTokenData(data);
        string memory imageURI = string.concat(
            "data:image/svg+xml;base64,",
            Base64.encode(bytes(_renderSVG(data.traits, data.fusionMass)))
        );
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
}
