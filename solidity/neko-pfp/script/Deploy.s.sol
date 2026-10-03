// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";

import {NekoRenderer} from "../src/NekoRenderer.sol";
import {NekoSeaDrop} from "../src/NekoSeaDrop.sol";
import {ISeaDrop, MultiConfigureStruct} from "../src/seadrop/SeaDropInterfaces.sol";

/// @notice Deploys the renderer and the NFT, then wires the SeaDrop payout and fee recipient.
///
///         Required env:
///           GENESIS_SEED_COMMITMENT  bytes32, keccak256(abi.encode(domain, seed)); see README
///           PAYOUT_ADDRESS           address that receives mint proceeds
///         Optional env:
///           SEADROP        defaults to the canonical SeaDrop address
///           FEE_RECIPIENT  defaults to OpenSea's fee wallet ("OpenSea: Fees 3")
///
///         Run:
///           forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PK --broadcast
contract Deploy is Script {
    address internal constant CANONICAL_SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant OPENSEA_FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;

    function run() external returns (NekoRenderer renderer, NekoSeaDrop neko) {
        bytes32 commitment = vm.envBytes32("GENESIS_SEED_COMMITMENT");
        address payout = vm.envAddress("PAYOUT_ADDRESS");
        address seaDrop = vm.envOr("SEADROP", CANONICAL_SEADROP);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", OPENSEA_FEE_RECIPIENT);

        MultiConfigureStruct memory config;
        config.seaDropImpl = seaDrop;
        config.creatorPayoutAddress = payout;
        config.allowedFeeRecipients = new address[](1);
        config.allowedFeeRecipients[0] = feeRecipient;

        vm.startBroadcast();
        renderer = new NekoRenderer();
        neko = new NekoSeaDrop(commitment, renderer, ISeaDrop(seaDrop));
        neko.multiConfigure(config);
        vm.stopBroadcast();
    }
}
