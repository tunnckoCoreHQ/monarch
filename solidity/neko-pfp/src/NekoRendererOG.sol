// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";
import {NekoBase} from "./NekoBase.sol";

/// @notice SVG scene composition, individual Neko art layers, metadata attributes,
///         palette labels, and toy lookup.
abstract contract NekoRenderer is NekoBase {
    function _renderSVG(RawTraits memory traits, string memory dna, uint256 fusionMass)
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
            '<svg viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg" data-dna="',
            dna,
            '" data-fusion-mass="',
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
            '<foreignObject id="fusion-diamond" x="51.5" y="30" width="12" height="12"><div xmlns="http://www.w3.org/1999/xhtml" style="width: 12px; height: 12px; font-size: 9px; line-height: 10px; text-align: center">',
            unicode"⭐️",
            "</div></foreignObject>"
        );
    }

    function _renderBackground(RawTraits memory traits) internal pure returns (string memory) {
        if (traits.matrix) {
            return _renderMatrixBackground();
        }

        string memory sky = _baseColor(traits.sky);
        return string.concat(
            '<rect id="sky" width="100%" height="100%" fill="',
            sky,
            '"/><rect id="ground" y="115" width="100%" height="35" fill="oklch(from ',
            sky,
            ' calc(l * 0.75) calc(c * 0.85) h)"/>'
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
        return string.concat(
            '<path id="body" fill="',
            _baseColor(traits.body),
            '" d="M105 95H45V81.5h3.333v-2.75h3.334V75h43v3.75h6.666v2.75H105V95z"/>',
            '<path id="tail" fill="',
            _baseColor(traits.tail),
            '" d="M96 82v-3h-3v-6h-3V61h3v-3h3v-3h3v-3h3v-3h3v6h-3v3h-3v3h-3v12h3v3h3v3h3v6h-6v-3z"/>'
        );
    }

    function _renderLegs(RawTraits memory traits) internal pure returns (string memory) {
        string memory backLegs = string.concat(
            '<path id="leg4" fill="',
            _baseColor(traits.legs[3]),
            '" d="M64.5 115H71v-3.344h3.25V95H64.5z"/>',
            '<path id="leg3" fill="',
            _baseColor(traits.legs[2]),
            '" d="M93.5 115h6.5v-3.344h3.25V95H93.5z"/>'
        );
        string memory frontLegs = string.concat(
            '<path id="leg2" fill="',
            _baseColor(traits.legs[1]),
            '" d="M79 115h6.5v-3.344h3.25V95H79z"/>',
            '<path id="leg1" fill="',
            _baseColor(traits.legs[0]),
            '" d="M45 115h6.5v-3.344h3.25V95H45z"/>'
        );
        return string.concat(backLegs, frontLegs);
    }

    function _renderFace(RawTraits memory traits) internal pure returns (string memory) {
        return string.concat(
            '<path id="eye1" fill="',
            _faceColor(traits.eyes[0]),
            '" d="M42.66 63.738h4v8h-4z"/>',
            '<path id="eye2" fill="',
            _faceColor(traits.eyes[1]),
            '" d="M68.33 63.738h4v8h-4z"/>',
            '<path id="mouth" fill="',
            _faceColor(traits.mouth),
            '" d="M52.33 73.475h10v4h-10z"/>'
        );
    }

    function _renderHead(RawTraits memory traits) internal pure returns (string memory) {
        return string.concat(
            '<path id="head" fill="',
            _baseColor(traits.head),
            '" d="M42.66 70.393h3.22v-6.655h-3.22v6.655zm19.25 6.328v-3.246h-9.58v3.246h9.58zm9.64-12.983h-3.22v6.655h3.22zM39.44 80.295v-3.574h-3.22v-3.246H33V57.082h3.22v-6.721h3.22v-6.672h3.22v-3.361h3.22v3.361h3.23v3.327h3.22v3.345h9.58v-3.345h3.22v-3.327h3.2v-3.361h3.22v3.361h3.22v6.672h3.22v6.721h3.22v16.393h-3.22v3.246h-3.22v3.574H71.55v3H42.66v-3H39.44z"/>'
        );
    }

    function _renderToy(RawTraits memory traits) internal pure returns (string memory) {
        return string.concat(
            '<foreignObject x="15" y="85" width="25" height="25"><div id="toy" data-toyName="',
            _toyName(traits.toy),
            '" xmlns="http://www.w3.org/1999/xhtml">',
            _toyGlyph(traits.toy),
            "</div></foreignObject>"
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

    function _dna(uint256 seed) internal pure returns (string memory) {
        return LibString.toHexString(seed, 32);
    }
}
