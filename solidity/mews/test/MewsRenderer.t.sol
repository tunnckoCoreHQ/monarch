// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";

contract RendererHarness is MewsRenderer {
    function colorsFor(uint256 index) external pure returns (Colors memory) {
        Traits memory selected;
        selected.coat = index;
        selected.face = index % ACCENT_COLORS;
        selected.collar = (index + 7) % ACCENT_COLORS;
        selected.background = index % BACKGROUND_COLORS;
        return _colors(selected);
    }

    function spriteFor(Pose pose, bool collar) external pure returns (bytes memory) {
        Traits memory selected;
        selected.pose = pose;
        selected.hasCollar = collar;
        return _sprite(selected);
    }
}

contract MewsRendererTest is Test {
    RendererHarness internal renderer;

    function setUp() public {
        renderer = new RendererHarness();
    }

    function testEyesAndShadowsPreserveCoatHueAndChroma() public view {
        for (uint256 i; i < renderer.COAT_COLORS(); ++i) {
            MewsRenderer.Colors memory colors = renderer.colorsFor(i);
            assertEq(colors.eyes.hue, colors.coat.hue);
            assertEq(colors.eyes.chroma, colors.coat.chroma);
            assertEq(colors.eyes.lightness + 25, colors.coat.lightness);
            assertEq(colors.shadow.hue, colors.coat.hue);
            assertEq(colors.shadow.chroma, colors.coat.chroma);
            assertEq(colors.shadow.lightness + 10, colors.coat.lightness);
            assertEq(colors.face.lightness, colors.eyes.lightness + 15);
            assertGe(colors.face.lightness, 76);
            assertLe(colors.face.lightness, 84);
        }
    }

    function testCollarDotLightensOrDarkensWithinPastelRange() public view {
        bool lightened;
        bool darkened;
        for (uint256 i; i < renderer.COAT_COLORS(); ++i) {
            MewsRenderer.Colors memory colors = renderer.colorsFor(i);
            assertEq(colors.collarDot.hue, colors.collar.hue);
            assertEq(colors.collar.lightness + 8, colors.coat.lightness);
            assertLe(colors.collar.chroma, 45);
            assertGe(colors.collarDot.lightness, 64);
            assertLe(colors.collarDot.lightness, 96);
            if (colors.collar.lightness >= 80) {
                darkened = true;
                assertLt(colors.collarDot.lightness, colors.collar.lightness);
                assertEq(colors.collarDot.chroma, colors.collar.chroma);
            } else {
                lightened = true;
                assertGt(colors.collarDot.lightness, colors.collar.lightness);
                assertLe(colors.collarDot.chroma, 15);
            }
        }
        assertTrue(lightened && darkened);
    }

    function testMirroredCollarLeavesTailAndGapIntact() public view {
        bytes memory pixels = renderer.spriteFor(MewsRenderer.Pose.Mirrored, true);
        assertEq(pixels.length, 144);
        assertEq(uint8(pixels[96]), 0x31);
        assertEq(uint8(pixels[97]), 0x30);
        assertEq(uint8(pixels[107]), 0x30);
        for (uint256 x = 2; x <= 10; ++x) {
            assertEq(uint8(pixels[96 + x]), x == 6 ? 0x36 : 0x35);
        }
    }

    function testLoafCollarCoversTheWholeNeck() public view {
        bytes memory pixels = renderer.spriteFor(MewsRenderer.Pose.Loaf, true);
        assertEq(pixels.length, 144);
        for (uint256 x; x < 11; ++x) {
            assertEq(uint8(pixels[96 + x]), x == 5 ? 0x36 : 0x35);
        }
        assertEq(uint8(pixels[107]), 0x30);
        assertEq(uint8(pixels[120]), 0x32);
    }

    function testHappyPoseKeepsItsLongNoseWithoutACollar() public view {
        bytes memory happy = renderer.spriteFor(MewsRenderer.Pose.Happy, false);
        for (uint256 i; i < happy.length; ++i) {
            assertTrue(happy[i] != "5" && happy[i] != "6");
        }
        assertEq(uint8(happy[61]), 0x34);
        assertEq(uint8(happy[77]), 0x33);
        assertEq(uint8(happy[89]), 0x33);
        assertEq(uint8(happy[101]), 0x31);
    }

    function testMirroringIncludesTheWholeCat() public view {
        bytes memory sitting = renderer.spriteFor(MewsRenderer.Pose.Sitting, true);
        bytes memory mirrored = renderer.spriteFor(MewsRenderer.Pose.Mirrored, true);
        for (uint256 y; y < 12; ++y) {
            for (uint256 x; x < 12; ++x) {
                assertEq(sitting[y * 12 + x], mirrored[y * 12 + 11 - x]);
            }
        }
    }

    function testCollarSelectionIsIndependentOfFaceDots() public view {
        MewsRenderer.Traits memory selected = renderer.traits(bytes32(0));
        assertTrue(selected.hasCollar);
        assertTrue(selected.collar != selected.face);
    }

    function testInvisibleCollarChoicesShareOneVisualHash() public view {
        bytes32 first = bytes32(uint256(2));
        bytes32 second = bytes32(uint256(2 + 4 * 36 * 24 * 5));
        assertEq(renderer.render(1, first), renderer.render(1, second));
        assertEq(renderer.visualHash(first), renderer.visualHash(second));
    }

    function testVisualHashIncludesSuppliedVisibleColors() public view {
        MewsRenderer.TokenData memory data = renderer.generate(bytes32(0));
        bytes32 original = renderer.visualHash(data.traits, data.colors);
        data.colors.eyes.lightness += 1;
        assertNotEq(renderer.visualHash(data.traits, data.colors), original);
        data.colors.eyes.lightness -= 1;
        data.colors.shadow.lightness += 1;
        assertNotEq(renderer.visualHash(data.traits, data.colors), original);
        data.colors.shadow.lightness -= 1;
        data.colors.collarDot.lightness += 1;
        assertNotEq(renderer.visualHash(data.traits, data.colors), original);

        data.traits.hasCollar = false;
        bytes32 withoutCollar = renderer.visualHash(data.traits, data.colors);
        data.colors.collarDot.lightness += 1;
        data.colors.collar.lightness += 1;
        assertEq(renderer.visualHash(data.traits, data.colors), withoutCollar);
    }

    function testPaletteBounds() public {
        vm.expectRevert(MewsRenderer.InvalidPaletteIndex.selector);
        renderer.palette(MewsRenderer.Palette.Coat, 36);
        vm.expectRevert(MewsRenderer.InvalidPaletteIndex.selector);
        renderer.paletteName(MewsRenderer.Palette.Coat, 36);
        vm.expectRevert(MewsRenderer.InvalidPaletteIndex.selector);
        renderer.palette(MewsRenderer.Palette.Accent, 24);
        vm.expectRevert(MewsRenderer.InvalidPaletteIndex.selector);
        renderer.palette(MewsRenderer.Palette.Background, 24);
    }

    function testBasicRendererMatchesPreservedGallery() public view {
        bytes32 seed = keccak256(
            abi.encode(
                keccak256("Mews preview genesis"), keccak256(abi.encode(uint256(123))), uint256(1)
            )
        );
        assertEq(renderer.render(1, seed), vm.readFile("test/fixtures/Mews.svg"));
    }

    function testRendererFitsDeploymentSizeLimit() public {
        MewsRenderer production = new MewsRenderer();
        assertLe(address(production).code.length, 24_576);
    }

    function testFuzzMetadataContainsTheRenderedImage(uint256 tokenId, bytes32 seed) public view {
        string memory uri = renderer.tokenURI(tokenId, seed);
        assertTrue(LibString.startsWith(uri, "data:application/json;base64,"));
        string memory json = string(Base64.decode(LibString.slice(uri, 29)));
        assertEq(
            vm.parseJsonString(json, ".name"), string.concat("Mews #", LibString.toString(tokenId))
        );
        string memory image = vm.parseJsonString(json, ".image");
        assertTrue(LibString.startsWith(image, "data:image/svg+xml;base64,"));
        string memory svg = string(Base64.decode(LibString.slice(image, 26)));
        assertEq(svg, renderer.render(tokenId, seed));
        assertTrue(LibString.endsWith(svg, "</svg>"));
        MewsRenderer.TokenData memory data = renderer.generate(seed);
        assertEq(data.seed, seed);
        MewsRenderer.Traits memory selected = data.traits;
        assertEq(abi.encode(selected), abi.encode(renderer.traits(seed)));
        MewsRenderer.TokenData memory explicitData = renderer.generate(selected);
        assertEq(explicitData.seed, renderer.visualHash(selected, data.colors));
        assertEq(explicitData.seed, renderer.visualHash(seed));
        assertEq(abi.encode(explicitData.colors), abi.encode(data.colors));
        assertEq(data.colors.eyes.hue, data.colors.coat.hue);
        assertEq(data.colors.eyes.chroma, data.colors.coat.chroma);
        assertEq(data.colors.eyes.lightness + 25, data.colors.coat.lightness);
        uint256 eyeHue = data.colors.eyes.hue;
        uint256 faceHue = data.colors.face.hue;
        uint256 hueDifference = eyeHue > faceHue ? eyeHue - faceHue : faceHue - eyeHue;
        assertGe(hueDifference, 60);
        assertLe(hueDifference, 300);
        if (selected.pose == MewsRenderer.Pose.Happy) {
            assertFalse(selected.hasCollar);
        }
        assertEq(
            vm.parseJsonString(json, ".attributes[1].value"),
            renderer.paletteName(MewsRenderer.Palette.Coat, selected.coat)
        );
        assertEq(
            vm.parseJsonString(json, ".attributes[3].value"),
            selected.hasCollar
                ? renderer.paletteName(MewsRenderer.Palette.Accent, selected.collar)
                : "None"
        );
    }
}
