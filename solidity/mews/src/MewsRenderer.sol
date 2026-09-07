// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

contract MewsRenderer {
    using LibString for uint256;

    error InvalidPaletteIndex();
    error InvalidTraits();

    uint256 public constant COAT_COLORS = 36;
    uint256 public constant ACCENT_COLORS = 24;
    uint256 public constant BACKGROUND_COLORS = 24;

    enum Palette {
        Coat,
        Accent,
        Background
    }

    enum Pose {
        Sitting,
        Mirrored,
        Happy,
        Loaf
    }

    // Lightness is a percentage; chroma is in thousandths; hue is in degrees.
    struct Color {
        uint256 lightness;
        uint256 chroma;
        uint256 hue;
    }

    struct Traits {
        Pose pose;
        uint256 coat;
        uint256 face;
        uint256 collar;
        uint256 background;
        bool hasCollar;
    }

    struct Colors {
        Color coat;
        Color shadow;
        Color eyes;
        Color face;
        Color collar;
        Color collarDot;
        Color background;
    }

    struct TokenData {
        bytes32 seed;
        Traits traits;
        Colors colors;
    }

    // Each entry stores one lightness byte, one chroma byte, and two hue bytes.
    bytes private constant COAT_PALETTE =
        hex"5b23000f5837000a5e16000f5a3c00375c2d00415741002d5e2d005a5c4100645a370055594100875c2d007d574100785a3700a55e1900a0573200965b2d00b9583c00be5e1400b9582d00f05c1e00e1573700e6573701045a2d01135e1400ff563c01275b2801225e14012c573201365a32013b583c0145583701635c2301595a2d00055e1600645c1e005059280046";

    bytes private constant ACCENT_PALETTE =
        hex"501e000f5037000f501e002d5037002d501e004b5037004b501e006950370069501e008750370087501e00a5503700a5501e00c3503700c3501e00e1503700e1501e00ff503700ff501e011d5037011d501e013b5037013b501e015950370159";
    bytes private constant BACKGROUND_PALETTE =
        hex"5219000f5228000f5219002d5228002d5219004b5228004b52190069522800695219008752280087521900a5522800a5521900c3522800c3521900e1522800e1521900ff522800ff5219011d5228011d5219013b5228013b5219015952280159";

    // 0 empty, 1 coat, 2 shadow, 3 face, 4 eyes, 5 collar, 6 collar dot.
    bytes private constant SITTING = "010000000100" "111000001110" "131000001310" "111111111110"
        "111111111110" "114111114110" "131113111310" "111111111110" "011111111201" "011111111201"
        "011111111201" "011121111222";
    bytes private constant LOAF = "010000000100" "111000001110" "131000001310" "111111111110"
        "111111111110" "144111144110" "131113111310" "111111111110" "111111111120" "111111111120"
        "222111111120" "112111112110";

    function palette(Palette kind, uint256 index) public pure returns (Color memory) {
        bytes memory values = kind == Palette.Coat
            ? COAT_PALETTE
            : kind == Palette.Accent ? ACCENT_PALETTE : BACKGROUND_PALETTE;
        if (index >= values.length / 4) {
            revert InvalidPaletteIndex();
        }
        uint256 offset = index * 4;
        return Color(
            uint8(values[offset]),
            uint8(values[offset + 1]),
            uint256(uint8(values[offset + 2])) * 256 + uint8(values[offset + 3])
        );
    }

    function paletteName(Palette kind, uint256 index) public pure returns (string memory) {
        uint256 count = kind == Palette.Coat
            ? COAT_COLORS
            : kind == Palette.Accent ? ACCENT_COLORS : BACKGROUND_COLORS;
        if (index >= count) {
            revert InvalidPaletteIndex();
        }
        if (kind == Palette.Coat) {
            string[36] memory coatNames = [
                "Rosewater",
                "Petal",
                "Pink Salt",
                "Peaches",
                "Apricot Cream",
                "Cantaloupe",
                "Vanilla",
                "Buttercup",
                "Custard",
                "Matcha",
                "Pistachio",
                "Pear",
                "Melon",
                "Mint Cream",
                "Celadon",
                "Seafoam",
                "Aquamarine",
                "Ice Mint",
                "Powder",
                "Blue Mist",
                "Sky",
                "Cornflower",
                "Periwinkle",
                "Frost",
                "Lilac",
                "Lavender",
                "Lilac Cream",
                "Wisteria",
                "Heather",
                "Orchid",
                "Blush",
                "Candyfloss",
                "Strawberry Milk",
                "Mochi",
                "Oat Milk",
                "Almond"
            ];
            return coatNames[index];
        }
        if (kind == Palette.Accent) {
            string[24] memory accentNames = [
                "Rose",
                "Rose Petal",
                "Peach",
                "Coral Cream",
                "Apricot",
                "Honey",
                "Butter",
                "Lemon Cream",
                "Sage",
                "Pistachio",
                "Mint",
                "Seafoam",
                "Aqua",
                "Lagoon",
                "Powder Blue",
                "Sky",
                "Cornflower",
                "Bluebell",
                "Lavender",
                "Periwinkle",
                "Lilac",
                "Orchid",
                "Blush",
                "Strawberry"
            ];
            return accentNames[index];
        }
        string[24] memory backgroundNames = [
            "Rose Mist",
            "Rose Haze",
            "Peach Mist",
            "Peach Haze",
            "Apricot Mist",
            "Apricot Haze",
            "Butter Mist",
            "Butter Haze",
            "Sage Mist",
            "Sage Haze",
            "Mint Mist",
            "Mint Haze",
            "Aqua Mist",
            "Aqua Haze",
            "Sky Mist",
            "Sky Haze",
            "Blue Mist",
            "Blue Haze",
            "Lavender Mist",
            "Lavender Haze",
            "Lilac Mist",
            "Lilac Haze",
            "Blush Mist",
            "Blush Haze"
        ];
        return backgroundNames[index];
    }

    function traits(bytes32 seed) public pure returns (Traits memory result) {
        uint256 value = uint256(seed);
        result.pose = Pose(value % 4);
        value /= 4;
        result.coat = value % COAT_COLORS;
        value /= COAT_COLORS;
        result.face = _facePalette(result.coat, value % ACCENT_COLORS);
        value /= ACCENT_COLORS;
        result.collar = value % ACCENT_COLORS;
        value /= ACCENT_COLORS;
        result.background = value % BACKGROUND_COLORS;
        value /= BACKGROUND_COLORS;
        result.hasCollar = result.pose != Pose.Happy && value % 2 == 0;
    }

    function mintSeed(bytes32 genesisSeed, address minter, uint256 tokenId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(genesisSeed, keccak256(abi.encode(minter)), tokenId));
    }

    function generate(bytes32 seed) public pure returns (TokenData memory data) {
        data.seed = seed;
        data.traits = traits(seed);
        data.colors = _colors(data.traits);
    }

    function generate(Traits calldata selected) public pure returns (TokenData memory data) {
        if (selected.pose == Pose.Happy && selected.hasCollar) {
            revert InvalidTraits();
        }
        data.traits = selected;
        data.colors = _colors(selected);
        data.seed = visualHash(data.traits, data.colors);
    }

    function visualHash(bytes32 seed) public pure returns (bytes32) {
        Traits memory selected = traits(seed);
        return visualHash(selected, _colors(selected));
    }

    function visualHash(Traits memory selected, Colors memory colors)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                selected.pose,
                colors.coat,
                colors.shadow,
                colors.eyes,
                colors.face,
                selected.hasCollar,
                selected.hasCollar ? colors.collar : Color(0, 0, 0),
                selected.hasCollar ? colors.collarDot : Color(0, 0, 0),
                colors.background
            )
        );
    }

    function render(uint256 tokenId, bytes32 seed) public pure returns (string memory) {
        return _render(tokenId, generate(seed));
    }

    function _render(uint256 tokenId, TokenData memory data)
        private
        pure
        returns (string memory svg)
    {
        bytes memory pixels = _sprite(data.traits);
        uint256 left = data.traits.pose == Pose.Loaf ? 5 : 4;
        string[7] memory fills = [
            "",
            _css(data.colors.coat),
            _css(data.colors.shadow),
            _css(data.colors.face),
            _css(data.colors.eyes),
            _css(data.colors.collar),
            _css(data.colors.collarDot)
        ];

        svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32" shape-rendering="crispEdges" role="img">',
            "<title>Mews #",
            tokenId.toString(),
            "</title>",
            '<rect width="32" height="32" fill="',
            _css(data.colors.background),
            '"/>'
        );

        for (uint256 y; y < 12; ++y) {
            uint256 x;
            while (x < 12) {
                bytes1 pixel = pixels[y * 12 + x];
                uint256 end = x + 1;
                while (end < 12 && pixels[y * 12 + end] == pixel) ++end;
                if (pixel != "0") {
                    svg = string.concat(
                        svg,
                        '<rect x="',
                        (x * 2 + left).toString(),
                        '" y="',
                        (y * 2 + 4).toString(),
                        '" width="',
                        ((end - x) * 2).toString(),
                        '" height="2" fill="',
                        fills[uint8(pixel) - 48],
                        '"/>'
                    );
                }
                x = end;
            }
        }
        return string.concat(svg, "</svg>");
    }

    function tokenURI(uint256 tokenId, bytes32 seed) public pure returns (string memory) {
        return _tokenURI(tokenId, generate(seed));
    }

    function _tokenURI(uint256 tokenId, TokenData memory data)
        private
        pure
        returns (string memory)
    {
        Traits memory selected = data.traits;
        string[4] memory poses = ["Sitting", "Mirrored", "Happy", "Loaf"];
        string memory attributes = string.concat(
            _attribute("Pose", poses[uint256(selected.pose)]),
            ",",
            _attribute("Coat", paletteName(Palette.Coat, selected.coat)),
            ",",
            _attribute("Face", paletteName(Palette.Accent, selected.face)),
            ",",
            _attribute(
                "Collar", selected.hasCollar ? paletteName(Palette.Accent, selected.collar) : "None"
            ),
            ",",
            _attribute("Background", paletteName(Palette.Background, selected.background))
        );
        string memory json = string.concat(
            '{"name":"Mews #',
            tokenId.toString(),
            '","description":"Pixel-perfect pastel Mews, generated and rendered entirely on-chain.',
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_render(tokenId, data))),
            '","attributes":[',
            attributes,
            "]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _colors(Traits memory selected) internal pure returns (Colors memory colors) {
        colors.coat = palette(Palette.Coat, selected.coat);
        colors.shadow = Color(colors.coat.lightness - 10, colors.coat.chroma, colors.coat.hue);
        colors.eyes = Color(colors.coat.lightness - 25, colors.coat.chroma, colors.coat.hue);

        colors.face = palette(Palette.Accent, selected.face);
        colors.face.lightness = colors.eyes.lightness + 15;
        colors.collar = palette(Palette.Accent, selected.collar);
        colors.collar.lightness = colors.coat.lightness - 8;
        if (colors.collar.chroma > 45) {
            colors.collar.chroma = 45;
        }
        colors.collarDot = Color(0, colors.collar.chroma, colors.collar.hue);
        if (colors.collar.lightness >= 80) {
            colors.collarDot.lightness = colors.collar.lightness - 16;
        } else {
            colors.collarDot.lightness = colors.collar.lightness + 18;
            if (colors.collarDot.lightness > 96) {
                colors.collarDot.lightness = 96;
            }
            if (colors.collarDot.chroma > 15) {
                colors.collarDot.chroma = 15;
            }
        }

        colors.background = palette(Palette.Background, selected.background);
        colors.background.lightness = colors.coat.lightness - 12;
        if (colors.background.chroma > 45) {
            colors.background.chroma = 45;
        }
    }

    function _facePalette(uint256 coat, uint256 candidate) internal pure returns (uint256 face) {
        uint256 coatHue = palette(Palette.Coat, coat).hue;
        face = candidate;
        // The fixed palette spans the hue wheel, so a separated color always exists.
        while (true) {
            uint256 faceHue = palette(Palette.Accent, face).hue;
            uint256 difference = coatHue > faceHue ? coatHue - faceHue : faceHue - coatHue;
            if (difference >= 60 && difference <= 300) {
                return face;
            }
            face = (face + 1) % ACCENT_COLORS;
        }
    }

    function _sprite(Traits memory selected) internal pure returns (bytes memory pixels) {
        pixels = selected.pose == Pose.Loaf ? LOAF : SITTING;
        if (selected.pose == Pose.Happy) {
            pixels[61] = "4";
            pixels[62] = "4";
            pixels[67] = "4";
            pixels[68] = "4";
            pixels[89] = "3";
        }

        if (selected.hasCollar) {
            uint256 start = selected.pose == Pose.Loaf ? 0 : 1;
            uint256 end = selected.pose == Pose.Loaf ? 11 : 10;
            for (uint256 x = start; x < end; ++x) {
                pixels[96 + x] = "5";
            }
            pixels[101] = "6";
        }

        if (selected.pose == Pose.Mirrored) {
            for (uint256 y; y < 12; ++y) {
                for (uint256 x; x < 6; ++x) {
                    uint256 left = y * 12 + x;
                    uint256 right = y * 12 + 11 - x;
                    (pixels[left], pixels[right]) = (pixels[right], pixels[left]);
                }
            }
        }
    }

    function _css(Color memory color) internal pure returns (string memory) {
        string memory padding = color.chroma < 10 ? "00" : "0";
        return string.concat(
            "oklch(",
            color.lightness.toString(),
            "% 0.",
            padding,
            color.chroma.toString(),
            " ",
            color.hue.toString(),
            ")"
        );
    }

    function _attribute(string memory name, string memory value)
        private
        pure
        returns (string memory)
    {
        return string.concat('{"trait_type":"', name, '","value":"', value, '"}');
    }
}
