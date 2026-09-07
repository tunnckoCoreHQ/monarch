// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {MewsArt} from "./MewsArt.sol";
import {MewsRenderer} from "./MewsRenderer.sol";

contract Mews is MewsArt {
    constructor(bytes32 genesisSeed, MewsRenderer renderer_) MewsArt(genesisSeed, renderer_) {}

    function mint(uint256 quantity) external nonReentrant {
        _mintCats(msg.sender, quantity);
    }
}
