// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {NekoRenderer} from "../../src/NekoRenderer.sol";

/// @notice Test double with the NekoRenderer ABI. Tests cast it to `NekoRenderer`.
contract MockNekoRenderer {
    struct Profile {
        bool configured;
        bool matrix;
        bool invisible;
        uint8 bodyIndex;
    }

    bytes32 private constant CAT_SIGNATURE_DOMAIN = keccak256("NEKO_PFP_CAT_SIGNATURE_V2");

    mapping(uint256 => Profile) private _profiles;
    mapping(uint256 => bool) private _hasTraits;
    mapping(uint256 => NekoRenderer.Traits) private _traits;
    Profile private _forcedProfile;

    function setForcedProfile(bool enabled, bool matrix, bool invisible, uint8 bodyIndex) external {
        _forcedProfile = Profile(enabled, matrix, invisible, bodyIndex);
    }

    function setRawTraits(uint256 seed, NekoRenderer.Traits calldata selected) external {
        _hasTraits[seed] = true;
        _traits[seed] = selected;
        _profiles[seed] = Profile(true, selected.matrix, selected.invisible, selected.body);
    }

    function traits(uint256 seed) public view returns (NekoRenderer.Traits memory result) {
        if (_hasTraits[seed]) {
            return _traits[seed];
        }

        (, bool invisible, uint8 bodyIndex) = _profile(seed);
        result.sky = invisible ? bodyIndex : bodyIndex == 0 ? 1 : 0;
        result.head = bodyIndex;
        result.face = bodyIndex % 13;
        result.body = bodyIndex;
        result.tail = bodyIndex;
        result.mouth = result.face;
        result.toy = uint8(seed % 37);
        result.invisible = invisible;
        for (uint256 i; i < 4; ++i) {
            result.legs[i] = bodyIndex;
        }
        for (uint256 i; i < 2; ++i) {
            result.eyes[i] = result.face;
        }
    }

    function profile(uint256 seed)
        external
        view
        returns (bool matrix, bool invisible, uint8 bodyIndex)
    {
        return _profile(seed);
    }

    function generate(uint256 seed) external view returns (NekoRenderer.TokenData memory) {
        return generate(traits(seed), 1);
    }

    function generate(NekoRenderer.Traits memory selected)
        external
        pure
        returns (NekoRenderer.TokenData memory)
    {
        return generate(selected, 1);
    }

    function generate(NekoRenderer.Traits memory selected, uint256 fusionMass)
        public
        pure
        returns (NekoRenderer.TokenData memory data)
    {
        data.traits = selected;
        data.fusionMass = fusionMass;
    }

    function combine(
        NekoRenderer.Traits calldata survivor,
        NekoRenderer.Traits calldata consumed,
        uint16 consumedPartsMask
    ) external pure returns (NekoRenderer.Traits memory combined) {
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

    function visualHash(NekoRenderer.Traits calldata selected) external pure returns (bytes32) {
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

    function render(NekoRenderer.TokenData calldata data) external pure returns (string memory) {
        return string(abi.encode(data));
    }

    function tokenURI(uint256 tokenId, NekoRenderer.TokenData calldata data)
        external
        pure
        returns (string memory)
    {
        return string(abi.encode(tokenId, data));
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

    function _normalize(NekoRenderer.Traits memory selected)
        private
        pure
        returns (NekoRenderer.Traits memory)
    {
        if (selected.matrix) {
            selected.sky = 0;
            selected.invisible = false;
        } else {
            bool invisible = selected.head == selected.sky && selected.body == selected.sky
                && selected.tail == selected.sky;
            for (uint256 i; i < 4; ++i) {
                invisible = invisible && selected.legs[i] == selected.sky;
            }
            selected.invisible = invisible;
        }

        selected.alternateHead = selected.head != selected.body;
        selected.alternateMouth = selected.mouth != selected.face;
        selected.alternateTail = selected.tail != selected.body;
        for (uint8 i; i < 4; ++i) {
            if (selected.legs[i] != selected.body) selected.alternateLegMask |= uint8(1) << i;
        }
        for (uint8 i; i < 2; ++i) {
            if (selected.eyes[i] != selected.face) selected.alternateEyeMask |= uint8(1) << i;
        }
        return selected;
    }
}
