// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {NekoBase} from "./NekoBase.sol";

/// @notice SVG scene composition, individual Neko art layers, metadata attributes,
///         palette labels, and toy lookup.
abstract contract NekoRenderer is NekoBase {
    function _renderSVG(RawTraits memory traits, uint256 fusionMass)
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

    function _renderBackground(RawTraits memory traits) internal pure returns (string memory) {
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

    function _renderBody(RawTraits memory traits) internal pure returns (string memory) {
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

    function _renderLegs(RawTraits memory traits) internal pure returns (string memory) {
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

    function _renderFace(RawTraits memory traits) internal pure returns (string memory) {
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

    function _renderHead(RawTraits memory traits) internal pure returns (string memory) {
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

    function _renderToy(RawTraits memory traits) internal pure returns (string memory) {
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
        RawTraits calldata traits = data.traits;
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

    function _alternateEyeValue(RawTraits calldata traits) internal pure returns (string memory) {
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

    function _alternateLegValue(RawTraits calldata traits)
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

    function _neckShadeColor(RawTraits memory traits) internal pure returns (string memory) {
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
