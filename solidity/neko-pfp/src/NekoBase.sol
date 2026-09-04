// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {INekoGenerator} from "./INekoGenerator.sol";

/// @notice Shared generator errors, limits, domains, trait math, and deterministic
///         visible, matrix, and invisible trait generation.
abstract contract NekoBase is INekoGenerator {
    error InvalidFusionMass();
    error InvalidMutationSelectionMask();
    error InvalidRawTraits();
    error InvalidTokenData();
    error NoValidColor();

    uint256 internal constant COLOR_COUNT = 20;
    uint256 internal constant FACE_COLOR_COUNT = 13;
    uint256 internal constant TOY_COUNT = 37;
    uint256 internal constant MAX_FUSION_MASS = 4663;
    uint16 internal constant ALL_PARTS_MASK = 0x1fff;
    uint256 internal constant BLACK = 16;
    uint256 internal constant WHITE = 17;
    uint256 internal constant GRAY = 18;
    uint256 internal constant SLATE = 19;
    uint256 internal constant NO_FORBIDDEN_COLOR = type(uint256).max;
    uint256 internal constant NO_REFERENCE = type(uint256).max;
    uint8 internal constant UNREVEALED_SKY = 8;
    uint8 internal constant UNREVEALED_BODY = 1;
    uint8 internal constant UNREVEALED_FACE = 9;
    bytes32 internal constant CAT_SIGNATURE_DOMAIN = keccak256("NEKO_PFP_CAT_SIGNATURE_V2");

    bytes32 internal constant SKY_SLOT = keccak256("SKY_SLOT");
    bytes32 internal constant SKY_SLOT_COLOR = keccak256("SKY_SLOT_COLOR");
    bytes32 internal constant MATRIX_TRIGGER = keccak256("MATRIX_TRIGGER");
    bytes32 internal constant INVISIBLE_TRIGGER = keccak256("INVISIBLE_TRIGGER");
    bytes32 internal constant BASE_CAT = keccak256("BASE_CAT");
    bytes32 internal constant BASE_CAT_CORRECTION = keccak256("BASE_CAT_CORRECTION");
    bytes32 internal constant ALTERNATE_HEAD_TRIGGER = keccak256("ALTERNATE_HEAD_TRIGGER");
    bytes32 internal constant ALTERNATE_HEAD_COLOR = keccak256("ALTERNATE_HEAD_COLOR");
    bytes32 internal constant ALTERNATE_HEAD_CORRECTION = keccak256("ALTERNATE_HEAD_CORRECTION");
    bytes32 internal constant BASE_FACE = keccak256("BASE_FACE");
    bytes32 internal constant BASE_FACE_CORRECTION = keccak256("BASE_FACE_CORRECTION");
    bytes32 internal constant ALTERNATE_EYE_TRIGGER = keccak256("ALTERNATE_EYE_TRIGGER");
    bytes32 internal constant ALTERNATE_EYE_POSITION = keccak256("ALTERNATE_EYE_POSITION");
    bytes32 internal constant ALTERNATE_EYE_COLOR = keccak256("ALTERNATE_EYE_COLOR");
    bytes32 internal constant ALTERNATE_EYE_CORRECTION = keccak256("ALTERNATE_EYE_CORRECTION");
    bytes32 internal constant ALTERNATE_MOUTH_TRIGGER = keccak256("ALTERNATE_MOUTH_TRIGGER");
    bytes32 internal constant ALTERNATE_MOUTH_COLOR = keccak256("ALTERNATE_MOUTH_COLOR");
    bytes32 internal constant ALTERNATE_MOUTH_CORRECTION = keccak256("ALTERNATE_MOUTH_CORRECTION");
    bytes32 internal constant ALTERNATE_LEG_TRIGGER = keccak256("ALTERNATE_LEG_TRIGGER");
    bytes32 internal constant ALTERNATE_LEG_POSITION = keccak256("ALTERNATE_LEG_POSITION");
    bytes32 internal constant ALTERNATE_LEG_COLOR = keccak256("ALTERNATE_LEG_COLOR");
    bytes32 internal constant ALTERNATE_LEG_CORRECTION = keccak256("ALTERNATE_LEG_CORRECTION");
    bytes32 internal constant ALTERNATE_TAIL_TRIGGER = keccak256("ALTERNATE_TAIL_TRIGGER");
    bytes32 internal constant ALTERNATE_TAIL_COLOR = keccak256("ALTERNATE_TAIL_COLOR");
    bytes32 internal constant ALTERNATE_TAIL_CORRECTION = keccak256("ALTERNATE_TAIL_CORRECTION");
    bytes32 internal constant INVISIBLE_BASE_FACE = keccak256("INVISIBLE_BASE_FACE");
    bytes32 internal constant INVISIBLE_BASE_FACE_CORRECTION =
        keccak256("INVISIBLE_BASE_FACE_CORRECTION");
    bytes32 internal constant INVISIBLE_ALTERNATE_EYE_TRIGGER =
        keccak256("INVISIBLE_ALTERNATE_EYE_TRIGGER");
    bytes32 internal constant INVISIBLE_ALTERNATE_EYE_POSITION =
        keccak256("INVISIBLE_ALTERNATE_EYE_POSITION");
    bytes32 internal constant INVISIBLE_ALTERNATE_EYE_COLOR =
        keccak256("INVISIBLE_ALTERNATE_EYE_COLOR");
    bytes32 internal constant INVISIBLE_ALTERNATE_EYE_CORRECTION =
        keccak256("INVISIBLE_ALTERNATE_EYE_CORRECTION");
    bytes32 internal constant INVISIBLE_ALTERNATE_MOUTH_TRIGGER =
        keccak256("INVISIBLE_ALTERNATE_MOUTH_TRIGGER");
    bytes32 internal constant INVISIBLE_ALTERNATE_MOUTH_COLOR =
        keccak256("INVISIBLE_ALTERNATE_MOUTH_COLOR");
    bytes32 internal constant INVISIBLE_ALTERNATE_MOUTH_CORRECTION =
        keccak256("INVISIBLE_ALTERNATE_MOUTH_CORRECTION");
    bytes32 internal constant TOY = keccak256("TOY");
    string internal constant TOY_NAMES =
        "mouse|rabbit|fish|blowfish|shark|octopus|steak|cheese|snake|pretzel|lobster|yarn|pineapple|banana|pear|crab|shrimp|eggplant|cucumber|popcorn|ear of corn|tropical fish|oyster|grapes|bacon|watermelon|squid|fish cake|peach|sushi|tangerine|mango|fried shrimp|meat on bone|milk|sausage|rubberduck";
    string internal constant TOY_GLYPHS =
        unicode"🐭🐇🐟🐡🦈🐙🥩🧀🐍🥨🦞🧶🍍🍌🍐🦀🦐🍆🥒🍿🌽🐠🦪🍇🥓🍉🦑🍥🍑🍣🍊🥭🍤🍖🥛🌭🦆";

    // ------------------------------------------------------------------
    // Trait generation
    // ------------------------------------------------------------------

    function _generationProfile(uint256 seed)
        internal
        pure
        returns (bool matrix, bool invisible, uint256 skyIndex, uint256 bodyIndex)
    {
        matrix = _roll(seed, MATRIX_TRIGGER, 100) < 3;
        if (matrix) {
            bodyIndex = _selectColor(
                seed, BASE_CAT, BASE_CAT_CORRECTION, false, BLACK, NO_REFERENCE, BLACK
            );
            return (true, false, 0, bodyIndex);
        }

        uint256 skySlot = _roll(seed, SKY_SLOT, 1024);
        skyIndex = uint256(keccak256(abi.encode(SKY_SLOT_COLOR, skySlot))) % COLOR_COUNT;
        invisible = _roll(seed, INVISIBLE_TRIGGER, 100) < 1;
        bodyIndex = invisible
            ? skyIndex
            : _selectColor(
                seed,
                BASE_CAT,
                BASE_CAT_CORRECTION,
                false,
                skyIndex,
                NO_REFERENCE,
                NO_FORBIDDEN_COLOR
            );
    }

    function _deriveVisibleTraits(
        uint256 seed,
        uint256 skyIndex,
        uint256 bodyIndex,
        RawTraits memory traits
    ) internal pure returns (RawTraits memory) {
        _fillBody(traits, bodyIndex);

        uint256 headIndex = bodyIndex;
        if (_roll(seed, ALTERNATE_HEAD_TRIGGER, 100) < 15) {
            headIndex = _selectColor(
                seed,
                ALTERNATE_HEAD_COLOR,
                ALTERNATE_HEAD_CORRECTION,
                false,
                bodyIndex,
                skyIndex,
                bodyIndex
            );
            traits.head = uint8(headIndex);
        }

        uint256 faceIndex = _selectColor(
            seed, BASE_FACE, BASE_FACE_CORRECTION, true, headIndex, NO_REFERENCE, NO_FORBIDDEN_COLOR
        );
        _fillFace(traits, faceIndex);

        if (_roll(seed, ALTERNATE_EYE_TRIGGER, 100) < 11) {
            uint8 alternateEye = uint8(
                _selectColor(
                    seed,
                    ALTERNATE_EYE_COLOR,
                    ALTERNATE_EYE_CORRECTION,
                    true,
                    headIndex,
                    NO_REFERENCE,
                    faceIndex
                )
            );
            traits.eyes[_roll(seed, ALTERNATE_EYE_POSITION, 2)] = alternateEye;
        }

        if (_roll(seed, ALTERNATE_MOUTH_TRIGGER, 100) < 8) {
            traits.mouth = uint8(
                _selectColor(
                    seed,
                    ALTERNATE_MOUTH_COLOR,
                    ALTERNATE_MOUTH_CORRECTION,
                    true,
                    headIndex,
                    NO_REFERENCE,
                    faceIndex
                )
            );
        }

        if (_roll(seed, ALTERNATE_LEG_TRIGGER, 100) < 13) {
            traits.legs[_roll(seed, ALTERNATE_LEG_POSITION, 4)] = uint8(
                _selectColor(
                    seed,
                    ALTERNATE_LEG_COLOR,
                    ALTERNATE_LEG_CORRECTION,
                    false,
                    skyIndex,
                    NO_REFERENCE,
                    bodyIndex
                )
            );
        }

        if (_roll(seed, ALTERNATE_TAIL_TRIGGER, 100) < 5) {
            traits.tail = uint8(
                _selectColor(
                    seed,
                    ALTERNATE_TAIL_COLOR,
                    ALTERNATE_TAIL_CORRECTION,
                    false,
                    skyIndex,
                    NO_REFERENCE,
                    bodyIndex
                )
            );
        }
        return traits;
    }

    function _deriveMatrixTraits(uint256 seed, uint256 bodyIndex, RawTraits memory traits)
        internal
        pure
        returns (RawTraits memory)
    {
        _fillBody(traits, bodyIndex);

        uint256 faceIndex = _selectColor(
            seed, BASE_FACE, BASE_FACE_CORRECTION, true, bodyIndex, NO_REFERENCE, NO_FORBIDDEN_COLOR
        );
        _fillFace(traits, faceIndex);

        if (_roll(seed, ALTERNATE_EYE_TRIGGER, 100) < 11) {
            traits.eyes[_roll(seed, ALTERNATE_EYE_POSITION, 2)] = uint8(
                _selectColor(
                    seed,
                    ALTERNATE_EYE_COLOR,
                    ALTERNATE_EYE_CORRECTION,
                    true,
                    bodyIndex,
                    NO_REFERENCE,
                    faceIndex
                )
            );
        }
        if (_roll(seed, ALTERNATE_MOUTH_TRIGGER, 100) < 8) {
            traits.mouth = uint8(
                _selectColor(
                    seed,
                    ALTERNATE_MOUTH_COLOR,
                    ALTERNATE_MOUTH_CORRECTION,
                    true,
                    bodyIndex,
                    NO_REFERENCE,
                    faceIndex
                )
            );
        }
        return traits;
    }

    function _deriveInvisibleTraits(uint256 seed, uint256 skyIndex, RawTraits memory traits)
        internal
        pure
        returns (RawTraits memory)
    {
        _fillBody(traits, skyIndex);

        uint256 faceIndex = _selectColor(
            seed,
            INVISIBLE_BASE_FACE,
            INVISIBLE_BASE_FACE_CORRECTION,
            true,
            skyIndex,
            NO_REFERENCE,
            NO_FORBIDDEN_COLOR
        );
        _fillFace(traits, faceIndex);

        if (_roll(seed, INVISIBLE_ALTERNATE_EYE_TRIGGER, 100) < 10) {
            traits.eyes[_roll(seed, INVISIBLE_ALTERNATE_EYE_POSITION, 2)] = uint8(
                _selectColor(
                    seed,
                    INVISIBLE_ALTERNATE_EYE_COLOR,
                    INVISIBLE_ALTERNATE_EYE_CORRECTION,
                    true,
                    skyIndex,
                    NO_REFERENCE,
                    faceIndex
                )
            );
        }
        if (_roll(seed, INVISIBLE_ALTERNATE_MOUTH_TRIGGER, 100) < 20) {
            traits.mouth = uint8(
                _selectColor(
                    seed,
                    INVISIBLE_ALTERNATE_MOUTH_COLOR,
                    INVISIBLE_ALTERNATE_MOUTH_CORRECTION,
                    true,
                    skyIndex,
                    NO_REFERENCE,
                    faceIndex
                )
            );
        }
        return traits;
    }

    function _fillBody(RawTraits memory traits, uint256 colorIndex) private pure {
        traits.head = uint8(colorIndex);
        traits.body = uint8(colorIndex);
        traits.tail = uint8(colorIndex);
        for (uint256 i; i < 4; ++i) {
            traits.legs[i] = uint8(colorIndex);
        }
    }

    function _fillFace(RawTraits memory traits, uint256 faceIndex) private pure {
        traits.face = uint8(faceIndex);
        traits.eyes[0] = uint8(faceIndex);
        traits.eyes[1] = uint8(faceIndex);
        traits.mouth = uint8(faceIndex);
    }

    // ------------------------------------------------------------------
    // Trait normalization, validation, and slop scoring
    // ------------------------------------------------------------------

    function _normalize(RawTraits memory traits) internal pure returns (RawTraits memory) {
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
        traits.alternateLegMask = 0;
        traits.alternateEyeMask = 0;

        for (uint8 i; i < 4; ++i) {
            if (traits.legs[i] != traits.body) {
                traits.alternateLegMask |= uint8(1) << i;
            }
        }
        for (uint8 i; i < 2; ++i) {
            if (traits.eyes[i] != traits.face) {
                traits.alternateEyeMask |= uint8(1) << i;
            }
        }

        return traits;
    }

    function _validateRawTraits(RawTraits memory traits) internal pure {
        bool validRanges = traits.sky < COLOR_COUNT && traits.head < COLOR_COUNT
            && traits.body < COLOR_COUNT && traits.tail < COLOR_COUNT
            && traits.face < FACE_COLOR_COUNT && traits.mouth < FACE_COLOR_COUNT
            && traits.toy < TOY_COUNT;

        for (uint8 i; i < 4; ++i) {
            validRanges = validRanges && traits.legs[i] < COLOR_COUNT;
        }
        for (uint8 i; i < 2; ++i) {
            validRanges = validRanges && traits.eyes[i] < FACE_COLOR_COUNT;
        }

        if (!validRanges) {
            revert InvalidRawTraits();
        }

        bool unusedMaskBits =
            traits.alternateLegMask & 0xf0 != 0 || traits.alternateEyeMask & 0xfc != 0;
        bool matrixConflict = traits.matrix && (traits.invisible || traits.sky != 0);

        if (unusedMaskBits || matrixConflict) {
            revert InvalidRawTraits();
        }

        uint8 expectedLegMask;
        uint8 expectedEyeMask;
        bool expectedInvisible = !traits.matrix && traits.head == traits.sky
            && traits.body == traits.sky && traits.tail == traits.sky;

        for (uint8 i; i < 4; ++i) {
            if (traits.legs[i] != traits.body) {
                expectedLegMask |= uint8(1) << i;
            }
            expectedInvisible = expectedInvisible && traits.legs[i] == traits.sky;
        }
        for (uint8 i; i < 2; ++i) {
            if (traits.eyes[i] != traits.face) {
                expectedEyeMask |= uint8(1) << i;
            }
        }

        bool consistentFlags = traits.alternateLegMask == expectedLegMask
            && traits.alternateEyeMask == expectedEyeMask
            && traits.alternateHead == (traits.head != traits.body)
            && traits.alternateMouth == (traits.mouth != traits.face)
            && traits.alternateTail == (traits.tail != traits.body)
            && traits.invisible == expectedInvisible;

        if (!consistentFlags) {
            revert InvalidRawTraits();
        }
    }

    function _validateTokenData(TokenData calldata data) internal pure {
        _validateRawTraits(data.traits);
        if (data.fusionMass == 0 || data.fusionMass > MAX_FUSION_MASS) {
            revert InvalidFusionMass();
        }
        if (data.slopTier != _slopTier(data.traits)) {
            revert InvalidTokenData();
        }
    }

    function _slopTier(RawTraits memory traits) internal pure returns (uint8 tier) {
        if (traits.alternateHead) ++tier;
        if (traits.alternateEyeMask != 0) ++tier;
        if (traits.alternateMouth) ++tier;
        if (traits.alternateLegMask != 0) ++tier;
        if (traits.alternateTail) ++tier;
    }

    // ------------------------------------------------------------------
    // Palette selection
    // ------------------------------------------------------------------

    /// @dev Preserves a valid preferred roll; otherwise selects uniformly from all valid colors.
    ///      Face colors map to base-palette contrast identities, including neutral colors.
    function _selectColor(
        uint256 seed,
        bytes32 preferredDomain,
        bytes32 correctionDomain,
        bool facePalette,
        uint256 reference1,
        uint256 reference2,
        uint256 forbidden
    ) internal pure returns (uint256) {
        uint256 paletteSize = facePalette ? FACE_COLOR_COUNT : COLOR_COUNT;
        uint256 preferred = _roll(seed, preferredDomain, paletteSize);
        if (_validColor(preferred, facePalette, reference1, reference2, forbidden)) {
            return preferred;
        }

        uint256[COLOR_COUNT] memory valid;
        uint256 validCount;

        for (uint256 candidate; candidate < paletteSize; ++candidate) {
            if (_validColor(candidate, facePalette, reference1, reference2, forbidden)) {
                valid[validCount] = candidate;
                ++validCount;
            }
        }
        if (validCount == 0) {
            revert NoValidColor();
        }

        return valid[_roll(seed, correctionDomain, validCount)];
    }

    function _validColor(
        uint256 candidate,
        bool facePalette,
        uint256 reference1,
        uint256 reference2,
        uint256 forbidden
    ) internal pure returns (bool) {
        if (candidate == forbidden) {
            return false;
        }

        uint256 hue = facePalette ? _facePaletteHue(candidate) : candidate;
        if (!_hasEnoughContrast(hue, reference1)) {
            return false;
        }

        return reference2 == NO_REFERENCE || _hasEnoughContrast(hue, reference2);
    }

    /// @dev Chromatic colors need circular hue separation; distinct neutral identities contrast.
    function _hasEnoughContrast(uint256 colorA, uint256 colorB) internal pure returns (bool) {
        if (colorA == colorB) {
            return false;
        }
        if (colorA >= BLACK || colorB >= BLACK) {
            return true;
        }

        uint256 difference = colorA > colorB ? colorA - colorB : colorB - colorA;
        uint256 distance = difference < 16 - difference ? difference : 16 - difference;
        return distance >= 4;
    }

    function _roll(uint256 seed, bytes32 domain, uint256 modulus) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, domain))) % modulus;
    }

    function _facePaletteHue(uint256 index) internal pure returns (uint256) {
        if (index == 0) return 0;
        if (index == 1) return 2;
        if (index == 2) return 3;
        if (index == 3) return 5;
        if (index == 4) return 6;
        if (index == 5) return 9;
        if (index == 6) return 10;
        if (index == 7) return 12;
        if (index == 8) return 15;
        if (index == 9) return BLACK;
        if (index == 10) return WHITE;
        if (index == 11) return GRAY;

        return SLATE;
    }
}
