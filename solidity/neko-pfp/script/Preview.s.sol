// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {NekoGenerator} from "../src/NekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";

/// @notice Shared tokenURI-to-SVG decoding for the local preview scripts.
abstract contract PreviewBase is Script {
    uint256 internal constant JSON_DATA_URI_PREFIX_LENGTH = 29; // "data:application/json;base64,"
    uint256 internal constant SVG_DATA_URI_PREFIX_LENGTH = 26; // "data:image/svg+xml;base64,"

    function _svgFromTokenURI(string memory uri) internal pure returns (string memory) {
        string memory json = string(
            Base64.decode(LibString.slice(uri, JSON_DATA_URI_PREFIX_LENGTH, bytes(uri).length))
        );
        uint256 key = LibString.indexOf(json, '"image":"');
        require(key != type(uint256).max, "image field not found");
        uint256 start = key + 9;
        uint256 end = LibString.indexOf(json, '"', start);
        string memory image = LibString.slice(json, start, end);
        return string(
            Base64.decode(LibString.slice(image, SVG_DATA_URI_PREFIX_LENGTH, bytes(image).length))
        );
    }

    function _fileName(uint256 tokenId) internal pure returns (string memory name) {
        name = LibString.toString(tokenId);
        while (bytes(name).length < 4) {
            name = string.concat("0", name);
        }
        name = string.concat("preview/", name, ".svg");
    }
}

/// @notice Local anvil preview: deploys the collection with the broadcaster acting as the
///         allowed SeaDrop, mints the full supply, snapshots one unrevealed tokenURI to
///         `preview/unrevealed.svg`, then reveals.
///
///         Run:
///           forge script script/Preview.s.sol:PreviewDeploy \
///             --rpc-url http://127.0.0.1:8545 --private-key $ANVIL_PK --broadcast
contract PreviewDeploy is PreviewBase {
    bytes32 internal constant GENESIS_SEED_COMMITMENT_DOMAIN =
        keccak256("NekoPFPSeaDrop.genesisSeedCommitment.v1");
    bytes32 internal constant GENESIS_SEED = keccak256("neko-pfp.preview-new-neko.genesis-seed.v1");
    uint256 internal constant MINT_BATCH = 500;

    function run() external returns (NekoGenerator generator, NekoPFP neko) {
        vm.createDir("preview", true);

        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        address[] memory allowedSeaDrop = new address[](1);
        allowedSeaDrop[0] = broadcaster;

        generator = new NekoGenerator();
        neko = new NekoPFP(
            "0xNeko PFP",
            "NEKO",
            allowedSeaDrop,
            generator,
            keccak256(abi.encode(GENESIS_SEED_COMMITMENT_DOMAIN, GENESIS_SEED))
        );

        uint256 remaining = neko.INTENDED_SUPPLY();
        while (remaining > 0) {
            uint256 quantity = remaining > MINT_BATCH ? MINT_BATCH : remaining;
            neko.mintSeaDrop(broadcaster, quantity);
            remaining -= quantity;
        }

        vm.writeFile("preview/unrevealed.svg", _svgFromTokenURI(neko.tokenURI(1)));

        neko.reveal(GENESIS_SEED);
        vm.stopBroadcast();

        console.log("NekoGenerator:", address(generator));
        console.log("NekoPFP:", address(neko));
    }
}

/// @notice Reads every revealed tokenURI from a deployed NekoPFP and writes the decoded
///         SVGs to `preview/<tokenId>.svg`.
///
///         Run (no broadcast; needs a large gas limit for the full sweep):
///           NEKO=<address> forge script script/Preview.s.sol:PreviewExport \
///             --rpc-url http://127.0.0.1:8545 --gas-limit 18446744073709551615
contract PreviewExport is PreviewBase {
    function run() external {
        vm.createDir("preview", true);
        NekoPFP neko = NekoPFP(vm.envAddress("NEKO"));
        uint256 supply = neko.INTENDED_SUPPLY();
        for (uint256 tokenId = 1; tokenId <= supply; ++tokenId) {
            vm.writeFile(_fileName(tokenId), _svgFromTokenURI(neko.tokenURI(tokenId)));
            if (tokenId % 500 == 0) {
                console.log("exported", tokenId);
            }
        }
    }
}
