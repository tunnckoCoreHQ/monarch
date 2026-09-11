// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {NekoRendererCore} from "./NekoRendererCore.sol";

/// @notice Deterministic Neko trait generation, fusion combination, SVG rendering, and
///         ERC-721 metadata. The public surface mirrors the Mews renderer.
contract NekoRenderer is NekoRendererCore {
    function traits(uint256 seed) public pure returns (Traits memory result) {
        (bool matrix, bool invisible, uint256 skyIndex, uint256 bodyIndex) =
            _generationProfile(seed);
        result.sky = uint8(skyIndex);
        result.body = uint8(bodyIndex);
        result.matrix = matrix;
        result.invisible = invisible;

        if (matrix) {
            result = _deriveMatrixTraits(seed, bodyIndex, result);
        } else if (invisible) {
            result = _deriveInvisibleTraits(seed, skyIndex, result);
        } else {
            result = _deriveVisibleTraits(seed, skyIndex, bodyIndex, result);
        }

        result.toy = uint8(_roll(seed, TOY, TOY_COUNT));
        return _normalize(result);
    }

    function profile(uint256 seed)
        external
        pure
        returns (bool matrix, bool invisible, uint8 bodyIndex)
    {
        uint256 selectedBodyIndex;
        (matrix, invisible,, selectedBodyIndex) = _generationProfile(seed);
        bodyIndex = uint8(selectedBodyIndex);
    }

    function generate(uint256 seed) external pure returns (TokenData memory data) {
        data.traits = traits(seed);
        data.slopTier = _slopTier(data.traits);
        data.fusionMass = 1;
    }

    function generate(Traits calldata selected) external pure returns (TokenData memory data) {
        return generate(selected, 1);
    }

    function generate(Traits calldata selected, uint256 fusionMass)
        public
        pure
        returns (TokenData memory data)
    {
        _validateTraits(selected);
        if (fusionMass == 0 || fusionMass > MAX_FUSION_MASS) {
            revert InvalidFusionMass();
        }
        data.traits = selected;
        data.slopTier = _slopTier(selected);
        data.fusionMass = fusionMass;
    }

    function combine(Traits calldata survivor, Traits calldata consumed, uint16 consumedPartsMask)
        external
        pure
        returns (Traits memory combined)
    {
        _validateTraits(survivor);
        _validateTraits(consumed);
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

    function visualHash(Traits calldata selected) external pure returns (bytes32) {
        _validateTraits(selected);
        return keccak256(
            abi.encode(
                CAT_SIGNATURE_DOMAIN,
                selected.matrix,
                selected.sky,
                selected.head,
                selected.face,
                selected.body,
                selected.tail,
                selected.legs,
                selected.eyes,
                selected.mouth
            )
        );
    }

    function render(TokenData calldata data) external pure returns (string memory) {
        _validateTokenData(data);
        return _render(data.traits, data.fusionMass);
    }

    function tokenURI(uint256 tokenId, TokenData calldata data)
        external
        pure
        returns (string memory)
    {
        _validateTokenData(data);
        return _tokenURI(tokenId, data);
    }

    function _tokenURI(uint256 tokenId, TokenData calldata data)
        private
        pure
        returns (string memory)
    {
        string memory imageURI = string.concat(
            "data:image/svg+xml;base64,",
            Base64.encode(bytes(_render(data.traits, data.fusionMass)))
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
