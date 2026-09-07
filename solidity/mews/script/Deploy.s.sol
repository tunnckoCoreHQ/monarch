// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {ISeaDrop, ISeaDropTokenContractMetadata} from "../src/seadrop/SeaDropInterfaces.sol";

contract Deploy is Script {
    error InvalidConfiguration();
    error InvalidDeployerKey();

    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant TRANSFER_VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant DEPLOYER = 0x6C22d03544609Db5128736706d90D66fC7f45388;
    bytes32 internal constant GENESIS_SEED =
        keccak256("Pixel-perfect pastel Mews, generated and rendered entirely on-chain.");

    // PRIVATE_KEY is loaded from the project's .env file. Configure the sale in OpenSea Studio.
    // Run through `vp run --filter mews deploy --rpc-url <Base RPC>` for a dry run.
    function run() external returns (MewsRenderer renderer, MewsSeaDrop mews) {
        if (block.chainid != 8453) {
            revert InvalidConfiguration();
        }
        _startBroadcast();
        renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        mews = new MewsSeaDrop(GENESIS_SEED, renderer, ISeaDrop(SEA_DROP));
        mews.setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo(DEPLOYER, 500));
        mews.setTransferValidator(TRANSFER_VALIDATOR);
        vm.stopBroadcast();
    }

    function _startBroadcast() internal virtual {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        if (privateKey == 0 || vm.addr(privateKey) != DEPLOYER) {
            revert InvalidDeployerKey();
        }
        vm.startBroadcast(privateKey);
    }
}
