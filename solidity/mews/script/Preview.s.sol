// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Mews} from "../src/Mews.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";

contract Preview is Script {
    using LibString for uint256;

    error IncompleteMint();
    error InvalidTemplate();

    function run() external {
        MewsRenderer renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        address recipient = address(0xA11CE);

        vm.prank(recipient);
        Mews mews = new Mews(keccak256("Mews preview genesis"), renderer);
        while (mews.totalSupply() < mews.MAX_SUPPLY()) {
            uint256 remaining = mews.MAX_SUPPLY() - mews.totalSupply();
            uint256 quantity = remaining < 50 ? remaining : 50;
            vm.prank(recipient);
            mews.mint(quantity);
        }
        if (mews.balanceOf(recipient) != mews.MAX_SUPPLY()) {
            revert IncompleteMint();
        }

        vm.createDir("preview/rendered", true);
        string memory template = vm.readFile("preview/template.html");
        uint256 marker = LibString.indexOf(template, "{{cats}}");
        if (marker == type(uint256).max) {
            revert InvalidTemplate();
        }
        string memory revision = vm.envOr("PREVIEW_REVISION", vm.unixTime().toString());
        string memory output = string.concat("preview/cats-", revision, ".html");
        vm.writeFile(output, LibString.slice(template, 0, marker));
        PreviewWriter writer = new PreviewWriter();
        for (uint256 tokenId = 1; tokenId <= mews.totalSupply(); ++tokenId) {
            writer.writeToken(mews, tokenId, output);
        }
        vm.writeLine(output, LibString.slice(template, marker + 8));
        vm.copyFile(output, "preview/index.html");
        console.log("Minted:", mews.totalSupply());
        console.log("Gallery:", output);
    }
}

// A separate call keeps memory bounded while exporting the full collection.
contract PreviewWriter is Script {
    using LibString for uint256;

    function writeToken(Mews mews, uint256 tokenId, string calldata output) external {
        string memory json = string(Base64.decode(LibString.slice(mews.tokenURI(tokenId), 29)));
        string memory image = vm.parseJsonString(json, ".image");
        string memory svg = string(Base64.decode(LibString.slice(image, 26)));
        string memory coat = vm.parseJsonString(json, ".attributes[1].value");
        vm.writeFile(string.concat("preview/rendered/", tokenId.toString(), ".svg"), svg);
        vm.writeLine(
            output,
            string.concat(
                '<figure data-token-id="',
                tokenId.toString(),
                '">',
                svg,
                "<figcaption>#",
                tokenId.toString(),
                " ",
                coat,
                "</figcaption></figure>"
            )
        );
    }
}
