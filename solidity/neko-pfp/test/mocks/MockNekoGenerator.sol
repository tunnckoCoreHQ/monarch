// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {INekoGenerator} from "../../src/INekoGenerator.sol";

contract MockNekoGenerator is INekoGenerator {
    struct Profile {
        bool configured;
        bool matrix;
        bool invisible;
        uint8 bodyIndex;
    }

    bytes32 private constant CAT_SIGNATURE_DOMAIN = keccak256("NEKO_PFP_CAT_SIGNATURE_V2");

    mapping(uint256 => Profile) private _profiles;
    mapping(uint256 => bool) private _hasTraits;
    mapping(uint256 => RawTraits) private _traits;
    Profile private _forcedProfile;

    function setForcedProfile(bool enabled, bool matrix, bool invisible, uint8 bodyIndex) external {
        _forcedProfile = Profile(enabled, matrix, invisible, bodyIndex);
    }

    function setRawTraits(uint256 seed, RawTraits calldata traits) external {
        _hasTraits[seed] = true;
        _traits[seed] = traits;
        _profiles[seed] = Profile(true, traits.matrix, traits.invisible, traits.body);
    }

    function deriveRawTraits(uint256 seed) external view returns (RawTraits memory) {
        if (_hasTraits[seed]) {
            return _traits[seed];
        }

        (, bool invisible, uint8 bodyIndex) = _profile(seed);
        RawTraits memory traits;
        traits.sky = invisible ? bodyIndex : bodyIndex == 0 ? 1 : 0;
        traits.head = bodyIndex;
        traits.face = bodyIndex % 13;
        traits.body = bodyIndex;
        traits.tail = bodyIndex;
        traits.mouth = traits.face;
        traits.toy = uint8(seed % 37);
        traits.invisible = invisible;
        for (uint256 i; i < 4; ++i) {
            traits.legs[i] = bodyIndex;
        }
        for (uint256 i; i < 2; ++i) {
            traits.eyes[i] = traits.face;
        }
        return traits;
    }

    function resolveTokenData(RawTraits calldata traits, uint256 fusionMass)
        external
        pure
        returns (TokenData memory data)
    {
        data.traits = traits;
        data.fusionMass = fusionMass;
    }

    function combineRawTraits(
        RawTraits calldata survivor,
        RawTraits calldata consumed,
        uint16 consumedPartsMask
    ) external pure returns (RawTraits memory combined) {
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

    function generateSVG(TokenData calldata data) external pure returns (string memory) {
        return string(abi.encode(data));
    }

    function generateImageURI(TokenData calldata data)
        external
        pure
        returns (string memory uri, bytes32 contentHash)
    {
        uri = string(abi.encode(data));
        contentHash = keccak256(bytes(uri));
    }

    function generateUnrevealedImageURI() external pure returns (string memory) {
        return "mock://unrevealed-image";
    }

    function generateUnrevealedTokenURI(uint256 tokenId) external pure returns (string memory) {
        return string(abi.encode("mock://unrevealed/", tokenId));
    }

    function generateTokenURI(uint256 tokenId, TokenData calldata data)
        external
        pure
        returns (string memory)
    {
        return string(abi.encode(tokenId, data));
    }

    function generationProfile(uint256 seed)
        external
        view
        returns (bool matrix, bool invisible, uint8 bodyIndex)
    {
        return _profile(seed);
    }

    function catSignature(RawTraits calldata traits) external pure returns (bytes32) {
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

    function _profile(uint256 seed)
        private
        view
        returns (bool matrix, bool invisible, uint8 bodyIndex)
    {
        Profile memory forced = _forcedProfile;
        if (forced.configured) {
            return (forced.matrix, forced.invisible, forced.bodyIndex);
        }

        Profile memory configured = _profiles[seed];
        if (configured.configured) {
            return (configured.matrix, configured.invisible, configured.bodyIndex);
        }

        uint256 selector = seed % 4;
        if (selector == 0) return (false, false, 16);
        if (selector == 1) return (false, false, 17);
        return (false, false, 2);
    }

    function _normalize(RawTraits memory traits) private pure returns (RawTraits memory) {
        if (traits.matrix) {
            traits.sky = 0;
            traits.invisible = false;
        } else {
            bool invisible =
                traits.head == traits.sky && traits.body == traits.sky && traits.tail == traits.sky;
            for (uint256 i; i < 4; ++i) {
                invisible = invisible && traits.legs[i] == traits.sky;
            }
            traits.invisible = invisible;
        }

        traits.alternateHead = traits.head != traits.body;
        traits.alternateMouth = traits.mouth != traits.face;
        traits.alternateTail = traits.tail != traits.body;
        for (uint8 i; i < 4; ++i) {
            if (traits.legs[i] != traits.body) traits.alternateLegMask |= uint8(1) << i;
        }
        for (uint8 i; i < 2; ++i) {
            if (traits.eyes[i] != traits.face) traits.alternateEyeMask |= uint8(1) << i;
        }
        return traits;
    }
}
