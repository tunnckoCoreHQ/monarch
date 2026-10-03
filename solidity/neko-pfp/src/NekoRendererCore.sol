// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";

/// @notice Raw Neko internals: errors, limits, keccak domains, trait math, deterministic
///         visible, matrix, and invisible trait generation, SVG layers, metadata attributes,
///         palette labels, and toy lookup. Nothing here is public.
abstract contract NekoRendererCore {
    struct Traits {
        uint8 sky;
        uint8 head;
        uint8 face;
        uint8 body;
        uint8 tail;
        uint8[4] legs;
        uint8[2] eyes;
        uint8 mouth;
        uint8 toy;
        uint8 alternateLegMask;
        uint8 alternateEyeMask;
        bool alternateHead;
        bool alternateMouth;
        bool alternateTail;
        bool invisible;
        bool matrix;
    }

    struct TokenData {
        Traits traits;
        uint8 slopTier;
        uint256 fusionMass;
    }

    error InvalidFusionMass();
    error InvalidMutationSelectionMask();
    error InvalidTraits();
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
        Traits memory traits
    ) internal pure returns (Traits memory) {
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

    function _deriveMatrixTraits(uint256 seed, uint256 bodyIndex, Traits memory traits)
        internal
        pure
        returns (Traits memory)
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

    function _deriveInvisibleTraits(uint256 seed, uint256 skyIndex, Traits memory traits)
        internal
        pure
        returns (Traits memory)
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

    function _fillBody(Traits memory traits, uint256 colorIndex) private pure {
        traits.head = uint8(colorIndex);
        traits.body = uint8(colorIndex);
        traits.tail = uint8(colorIndex);
        for (uint256 i; i < 4; ++i) {
            traits.legs[i] = uint8(colorIndex);
        }
    }

    function _fillFace(Traits memory traits, uint256 faceIndex) private pure {
        traits.face = uint8(faceIndex);
        traits.eyes[0] = uint8(faceIndex);
        traits.eyes[1] = uint8(faceIndex);
        traits.mouth = uint8(faceIndex);
    }

    // ------------------------------------------------------------------
    // Trait normalization, validation, and slop scoring
    // ------------------------------------------------------------------

    function _normalize(Traits memory traits) internal pure returns (Traits memory) {
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

    function _validateTraits(Traits memory traits) internal pure {
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
            revert InvalidTraits();
        }

        bool unusedMaskBits =
            traits.alternateLegMask & 0xf0 != 0 || traits.alternateEyeMask & 0xfc != 0;
        bool matrixConflict = traits.matrix && (traits.invisible || traits.sky != 0);

        if (unusedMaskBits || matrixConflict) {
            revert InvalidTraits();
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
            revert InvalidTraits();
        }
    }

    function _validateTokenData(TokenData calldata data) internal pure {
        _validateTraits(data.traits);
        if (data.fusionMass == 0 || data.fusionMass > MAX_FUSION_MASS) {
            revert InvalidFusionMass();
        }
        if (data.slopTier != _slopTier(data.traits)) {
            revert InvalidTokenData();
        }
    }

    function _slopTier(Traits memory traits) internal pure returns (uint8 tier) {
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

    // ------------------------------------------------------------------
    // SVG scene composition and metadata attributes
    // ------------------------------------------------------------------

    function _render(Traits memory traits, uint256 fusionMass)
        internal
        pure
        returns (string memory)
    {
        string memory scene = string.concat(
            _renderBackground(traits), _renderFusionStar(fusionMass), _renderBody(traits)
        );
        string memory cat =
            string.concat(_renderLegs(traits), _renderFace(traits), _renderHead(traits));

        return string.concat(
            '<svg viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg" data-fusion-mass="',
            LibString.toString(fusionMass),
            '" shape-rendering="crispEdges" image-rendering="pixelated">',
            scene,
            cat,
            _renderToy(traits),
            "</svg>"
        );
    }

    function _renderFusionStar(uint256 fusionMass) internal pure returns (string memory) {
        if (fusionMass == 1) {
            return "";
        }

        return string.concat(
            '<text id="fusion-diamond" x="57.5" y="35" text-anchor="middle" dominant-baseline="central" font-size="9" fill="#f9d100">',
            unicode"★",
            "</text>"
        );
    }

    function _renderBackground(Traits memory traits) internal pure returns (string memory) {
        if (traits.matrix) {
            return _renderMatrixBackground();
        }

        string memory sky = _baseColor(traits.sky);
        string memory background = string.concat(
            '<rect width="100%" height="100%" fill="',
            sky,
            '"/><rect y="115" width="100%" height="35" fill="oklch(from ',
            sky,
            ' calc(l * 0.75) calc(c * 0.85) h)"/>'
        );
        if (traits.invisible || traits.sky == BLACK) {
            return background;
        }

        return string.concat(
            background,
            '<path fill="oklch(from ',
            sky,
            ' calc(l * 0.68) calc(c * 0.9) h)" d="M53 115h57v3H53zM65 118h51v3H65z"/>'
        );
    }

    /// @dev Compact static code rain based on the accepted Matrix demo. All layers fill 150x150.
    function _renderMatrixBackground() internal pure returns (string memory) {
        return string.concat(
            '<defs><path id="ma" d="M0 0h4v1H2v1h2v1H1v2h3v1H0V4h1V2H0z"/><path id="mb" d="M1 0h2v1h1v2H3v1h1v2H1V5H0V3h2V2H0V1h1z"/><path id="mf" d="M1 0h2v1H2v2H1v1H0V2h1z"/></defs><rect id="matrix" width="150" height="150" fill="#000603"/>',
            '<g fill="#003d18"><use href="#ma" x="5" y="4"/><use href="#mb" x="5" y="14"/><use href="#ma" x="5" y="24"/><use href="#mb" x="26" y="45"/><use href="#ma" x="26" y="55"/><use href="#ma" x="113" y="31"/><use href="#mb" x="113" y="41"/><use href="#mb" x="134" y="2"/><use href="#ma" x="134" y="12"/><use href="#mb" x="134" y="22"/></g>',
            '<g fill="#007326"><use href="#mb" x="5" y="34"/><use href="#ma" x="26" y="65"/><use href="#ma" x="48" y="3"/><use href="#mb" x="48" y="13"/><use href="#ma" x="92" y="9"/><use href="#mb" x="92" y="19"/><use href="#ma" x="113" y="51"/><use href="#mb" x="134" y="32"/><use href="#ma" x="14" y="119"/><use href="#mb" x="14" y="129"/><use href="#ma" x="123" y="118"/><use href="#mb" x="123" y="128"/></g>',
            '<g fill="#00bf35"><use href="#ma" x="5" y="44"/><use href="#mb" x="26" y="75"/><use href="#ma" x="48" y="23"/><use href="#mb" x="92" y="29"/><use href="#mb" x="113" y="61"/><use href="#ma" x="134" y="42"/><use href="#ma" x="14" y="89"/><use href="#mb" x="14" y="99"/><use href="#mb" x="123" y="88"/><use href="#ma" x="48" y="103"/><use href="#mb" x="48" y="113"/><use href="#ma" x="92" y="109"/><use href="#mb" x="92" y="119"/><use href="#ma" x="134" y="102"/><use href="#mb" x="134" y="112"/></g>',
            '<g fill="#62ff8a"><use href="#mb" x="48" y="33"/><use href="#ma" x="92" y="39"/><use href="#ma" x="113" y="71"/><use href="#mb" x="134" y="52"/><use href="#ma" x="14" y="109"/><use href="#ma" x="123" y="98"/><use href="#mb" x="48" y="123"/><use href="#ma" x="92" y="129"/><use href="#ma" x="134" y="122"/></g>',
            '<g fill="#00541f" opacity=".72"><use href="#mf" x="3" y="72"/><use href="#mf" x="15" y="8"/><use href="#mf" x="17" y="29"/><use href="#mf" x="31" y="25"/><use href="#mf" x="36" y="10"/><use href="#mf" x="38" y="31"/><use href="#mf" x="58" y="12"/><use href="#mf" x="61" y="34"/><use href="#mf" x="70" y="3"/><use href="#mf" x="73" y="23"/><use href="#mf" x="82" y="13"/><use href="#mf" x="102" y="5"/><use href="#mf" x="100" y="27"/><use href="#mf" x="124" y="15"/><use href="#mf" x="122" y="36"/><use href="#mf" x="144" y="18"/><use href="#mf" x="20" y="116"/><use href="#mf" x="41" y="124"/><use href="#mf" x="67" y="121"/><use href="#mf" x="86" y="126"/><use href="#mf" x="110" y="116"/><use href="#mf" x="137" y="128"/></g>'
        );
    }

    function _renderBody(Traits memory traits) internal pure returns (string memory) {
        string memory body = string.concat(
            '<path fill="',
            _baseColor(traits.body),
            '" d="M113 95H53V81h3v-3h3V75h44v1h2v1h2v1h2v1h2v1h1v1h1V95z"/>'
        );
        string memory tail = string.concat(
            '<path fill="',
            _baseColor(traits.tail),
            '" d="M99 58h3v-3h3v-3h3v-3h3v-3h3v6h-3v3h-3v3h-3zM102 58h3v12h-3zM104 67h3v6h-3zM106 70h3v6h-3zM108 73h3v6h-3zM110 76h3v6h-3z"/>'
        );
        if (traits.invisible) {
            return string.concat(body, tail);
        }

        return string.concat(
            body,
            tail,
            '<path fill="',
            _baseShadeColor(traits.tail, "0.75", "0.9"),
            '" d="M111 46h3v1h-1v1h-1v1h-1z"/>'
        );
    }

    function _renderLegs(Traits memory traits) internal pure returns (string memory) {
        string memory backLegs = string.concat(
            '<path fill="',
            _baseColor(traits.legs[3]),
            '" d="M71 115h7v-3h2V95H71z"/>',
            '<path fill="',
            _baseColor(traits.legs[2]),
            '" d="M101 115h7v-3h2V95H101z"/>'
        );
        string memory frontLegs = string.concat(
            '<path fill="',
            _baseColor(traits.legs[1]),
            '" d="M86 115h7v-3h2V95H86z"/>',
            '<path fill="',
            _baseColor(traits.legs[0]),
            '" d="M53 115h7v-3h2V95H53z"/>'
        );
        if (traits.invisible) {
            return string.concat(backLegs, frontLegs);
        }

        return string.concat(
            backLegs,
            frontLegs,
            '<g><path fill="',
            _pawAccentColor(traits.legs[0]),
            '" d="M55 112h1v3h-1zM57 112h1v3h-1z"/><path fill="',
            _pawAccentColor(traits.legs[3]),
            '" d="M73 112h1v3h-1zM75 112h1v3h-1z"/><path fill="',
            _pawAccentColor(traits.legs[1]),
            '" d="M88 112h1v3h-1zM90 112h1v3h-1z"/><path fill="',
            _pawAccentColor(traits.legs[2]),
            '" d="M103 112h1v3h-1zM105 112h1v3h-1z"/></g>'
        );
    }

    function _renderFace(Traits memory traits) internal pure returns (string memory) {
        return string.concat(
            '<path fill="',
            _faceColor(traits.eyes[0]),
            '" d="M50 64h4v8h-4z"/>',
            '<path fill="',
            _faceColor(traits.eyes[1]),
            '" d="M74 64h4v8h-4z"/>',
            '<path fill="',
            _faceColor(traits.mouth),
            '" d="M58 74h4v1h-4zM65 74h4v1h-4zM59 75h4v1h-4zM64 75h4v1h-4zM60 76h7v1h-7z"/>'
        );
    }

    function _renderHead(Traits memory traits) internal pure returns (string memory) {
        string memory headColor = _baseColor(traits.head);
        string memory renderedHead = string.concat(
            '<path fill="',
            headColor,
            '" d="M50 71h3v-6h-3v6zM58 75h4v-1h-4zM65 75h4v-1h-4zM59 76h4v-1h-4zM64 76h4v-1h-4zM60 77h7v-1h-7zM77 65h-3v6h3zM41 56h3v-6h3v-6h3v-3h3v3h3v3h3v3h9v-3h3v-3h3v-3h3v3h3v6h3v6h3v5h1v6h-1v6h-1v3h-2v3h-2v2h-3v2h-3v1H52v-1h-3v-2h-3v-2h-2v-3h-2v-3h-1v-6h-1v-6h1v-5zM83 76h1v1h-1zM51 83h1v1h-1zM52 78H82v2h-1v1h-1v1h-1v1h-1v1h-1v1h-2v1h-3v1h-4v1h-9v-1h-3v-1h-2v-2h-2zM53 84h1v1h-1z"/>'
        );
        string memory gaze = string.concat(
            _renderGaze(traits.eyes[0], "M50 68h2v3h-2z"),
            _renderGaze(traits.eyes[1], "M74 68h2v3h-2z")
        );
        if (traits.invisible) {
            return string.concat(renderedHead, gaze);
        }

        string memory earAccent = _earAccentColor(traits.head);
        string memory neckShade = _neckShadeColor(traits);
        string memory noseAccent = _noseAccentColor(traits.head);
        return string.concat(
            renderedHead,
            '<path fill="',
            noseAccent,
            '" d="M62 74h3v1h-3zM63 75h1v1h-1z"/>',
            gaze,
            '<path fill="',
            neckShade,
            '" d="M54 85h2v1h3v1h9v-1h4v-1h3v-1h2v-1h1v-1h1v-1h1v1h-1v1h-1v1h-1v1h-2v1h-3v1h-4v1h-9v-1h-3v-1h-2zM80 80h1v1h-1zM81 79h1v1h-1z"/>',
            '<path fill="',
            earAccent,
            '" d="M50 47h3v3h-3zM74 47h3v3h-3z"/>',
            '<path fill="',
            noseAccent,
            '" d="M62 72h3v2h-3z"/>'
        );
    }

    function _renderToy(Traits memory traits) internal pure returns (string memory) {
        return string.concat(
            '<text id="toy" data-toyName="',
            _toyName(traits.toy),
            '" x="33" y="95" text-anchor="middle" dominant-baseline="central" font-size="16">',
            _toyGlyph(traits.toy),
            "</text>"
        );
    }

    // ------------------------------------------------------------------
    // Metadata attributes
    // ------------------------------------------------------------------

    function _attributes(TokenData calldata data) internal pure returns (string memory attributes) {
        Traits calldata traits = data.traits;
        if (traits.matrix) {
            attributes = '[{"trait_type":"Background","value":"Matrix"}';
        } else {
            attributes =
                string.concat('[{"trait_type":"Sky","value":"', _baseColor(traits.sky), '"}');
        }
        attributes = string.concat(
            attributes,
            ',{"trait_type":"Head","value":"',
            _baseColor(traits.head),
            '"},{"trait_type":"Face","value":"',
            _faceColor(traits.face),
            '"},{"trait_type":"Body","value":"',
            _baseColor(traits.body),
            '"},{"trait_type":"Tail","value":"',
            _baseColor(traits.tail),
            '"},{"trait_type":"Toy","value":"',
            _toyName(traits.toy),
            '"},{"trait_type":"Invisible","value":"',
            traits.invisible ? "Yes" : "No",
            '"}'
        );

        if (traits.alternateHead) {
            attributes = string.concat(attributes, ',{"trait_type":"Alternate Head","value":"Yes"}');
        }
        if (traits.alternateEyeMask != 0) {
            attributes = string.concat(
                attributes,
                ',{"trait_type":"Alternate Eye","value":"',
                _alternateEyeValue(traits),
                '"}'
            );
        }
        if (traits.alternateMouth) {
            attributes = string.concat(
                attributes,
                ',{"trait_type":"Alternate Mouth","value":"',
                _faceColor(traits.mouth),
                '"}'
            );
        }
        if (traits.alternateLegMask != 0) {
            attributes = string.concat(
                attributes,
                ',{"trait_type":"Alternate Leg","value":"',
                _alternateLegValue(traits),
                '"}'
            );
        }
        if (traits.alternateTail) {
            attributes = string.concat(attributes, ',{"trait_type":"Alternate Tail","value":"Yes"}');
        }
        return string.concat(
            attributes,
            ',{"display_type":"number","trait_type":"Slop Tier","value":',
            LibString.toString(data.slopTier),
            "}]"
        );
    }

    function _alternateEyeValue(Traits calldata traits) internal pure returns (string memory) {
        if (traits.alternateEyeMask == 1) {
            return _faceColor(traits.eyes[0]);
        }
        if (traits.alternateEyeMask == 2) {
            return _faceColor(traits.eyes[1]);
        }

        return string.concat(
            "Left: ", _faceColor(traits.eyes[0]), ", Right: ", _faceColor(traits.eyes[1])
        );
    }

    function _alternateLegValue(Traits calldata traits)
        internal
        pure
        returns (string memory value)
    {
        uint8 mask = traits.alternateLegMask;
        if (mask & (mask - 1) == 0) {
            for (uint8 i; i < 4; ++i) {
                if (mask & (uint8(1) << i) != 0) {
                    return _baseColor(traits.legs[i]);
                }
            }
        }
        for (uint8 i; i < 4; ++i) {
            if (mask & (uint8(1) << i) != 0) {
                string memory entry =
                    string.concat(LibString.toString(i + 1), ": ", _baseColor(traits.legs[i]));
                value = bytes(value).length == 0 ? entry : string.concat(value, ", ", entry);
            }
        }
    }

    function _baseColor(uint256 index) internal pure returns (string memory) {
        if (index == 0) return "oklch(0.63 0.3 25)";
        if (index == 1) return "oklch(0.72 0.28 55)";
        if (index == 2) return "oklch(0.87 0.22 95)";
        if (index == 3) return "oklch(0.84 0.27 120)";
        if (index == 4) return "oklch(0.79 0.3 145)";
        if (index == 5) return "oklch(0.75 0.25 170)";
        if (index == 6) return "oklch(0.7 0.21 180)";
        if (index == 7) return "oklch(0.78 0.2 200)";
        if (index == 8) return "oklch(0.8 0.18 220)";
        if (index == 9) return "oklch(0.55 0.33 260)";
        if (index == 10) return "oklch(0.5 0.31 275)";
        if (index == 11) return "oklch(0.6 0.32 295)";
        if (index == 12) return "oklch(0.55 0.3 310)";
        if (index == 13) return "oklch(0.65 0.34 330)";
        if (index == 14) return "oklch(0.75 0.24 5)";
        if (index == 15) return "oklch(0.68 0.26 15)";
        if (index == BLACK) return "oklch(0 0 0)";
        if (index == WHITE) return "oklch(1 0 0)";
        if (index == GRAY) return "oklch(0.7 0 0)";

        return "oklch(0.5 0.03 255)";
    }

    function _faceColor(uint256 index) internal pure returns (string memory) {
        return _baseColor(_facePaletteHue(index));
    }

    function _pawAccentColor(uint256 index) internal pure returns (string memory) {
        string memory color = _baseColor(index);
        if (index == BLACK) {
            return "oklch(0.35 0 0)";
        }
        if (index == WHITE) {
            return _monochromeAccentColor(index, color);
        }

        return string.concat("oklch(from ", color, " calc(l * 0.84) calc(c * 0.95) h)");
    }

    function _gazeColor(uint256 index) internal pure returns (string memory) {
        uint256 baseIndex = _facePaletteHue(index);
        string memory color = _baseColor(baseIndex);
        if (_isDarkBaseColor(baseIndex)) {
            return string.concat("oklch(from ", color, " calc(0.65 + l * 0.35) calc(c * 0.5) h)");
        }

        return string.concat("oklch(from ", color, " calc(l * 0.65) calc(c * 0.85) h)");
    }

    function _renderGaze(uint256 index, string memory path) internal pure returns (string memory) {
        if (index == 0 || index == 5 || index == 6 || index == 9 || index == 11) {
            return "";
        }

        string memory color = index == 10 ? _baseColor(BLACK) : _gazeColor(index);
        return string.concat('<path fill="', color, '" d="', path, '"/>');
    }

    function _baseShadeColor(uint256 index, string memory lightness, string memory chroma)
        internal
        pure
        returns (string memory)
    {
        string memory color = _baseColor(index);
        if (index == BLACK || index == WHITE) {
            return _monochromeAccentColor(index, color);
        }

        return
            string.concat(
                "oklch(from ", color, " calc(l * ", lightness, ") calc(c * ", chroma, ") h)"
            );
    }

    function _earAccentColor(uint256 index) internal pure returns (string memory) {
        string memory color = _baseColor(index);
        if (index == BLACK) {
            return "oklch(0.3 0 0)";
        }
        return string.concat("oklch(from ", color, " calc(l - 0.15) calc(c * 0.75) h)");
    }

    function _noseAccentColor(uint256 index) internal pure returns (string memory) {
        string memory color = _baseColor(index);
        if (index == BLACK) {
            return "oklch(0.3 0 0)";
        }

        return string.concat("oklch(from ", color, " calc(l * 0.69) calc(c * 0.9) h)");
    }

    function _neckShadeColor(Traits memory traits) internal pure returns (string memory) {
        if (traits.head == BLACK && traits.body == BLACK) {
            return "oklch(0.18 0 0)";
        }

        return _baseShadeColor(traits.head, "0.9", "0.9");
    }

    function _monochromeAccentColor(uint256 index, string memory color)
        internal
        pure
        returns (string memory)
    {
        if (index == BLACK) {
            return "oklch(0.3 0 0)";
        }

        return string.concat("oklch(from ", color, " calc(l * 0.85) calc(c * 0.5) h)");
    }

    function _isDarkBaseColor(uint256 index) internal pure returns (bool) {
        return
            index == 9 || index == 10 || index == 11 || index == 12 || index == BLACK
                || index == SLATE;
    }

    function _toyName(uint256 index) internal pure returns (string memory) {
        bytes memory names = bytes(TOY_NAMES);
        uint256 start;
        uint256 current;
        for (uint256 i; i < names.length; ++i) {
            if (names[i] != "|") {
                continue;
            }
            if (current == index) {
                return _slice(names, start, i - start);
            }
            ++current;
            start = i + 1;
        }

        return _slice(names, start, names.length - start);
    }

    function _toyGlyph(uint256 index) internal pure returns (string memory) {
        bytes memory glyphs = bytes(TOY_GLYPHS);

        return _slice(glyphs, index * 4, 4);
    }

    function _slice(bytes memory source, uint256 start, uint256 length)
        internal
        pure
        returns (string memory)
    {
        bytes memory result = new bytes(length);

        for (uint256 i; i < length; ++i) {
            result[i] = source[start + i];
        }

        return string(result);
    }
}
