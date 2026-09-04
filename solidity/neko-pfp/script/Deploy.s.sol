// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";

import {NekoGenerator} from "../src/NekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";

/// @notice Deploys the generator and the NFT, then wires the SeaDrop payout and fee recipient.
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

    function run() external returns (NekoGenerator generator, NekoPFP neko) {
        bytes32 commitment = vm.envBytes32("GENESIS_SEED_COMMITMENT");
        address payout = vm.envAddress("PAYOUT_ADDRESS");
        address seaDrop = vm.envOr("SEADROP", CANONICAL_SEADROP);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", OPENSEA_FEE_RECIPIENT);

        address[] memory allowedSeaDrop = new address[](1);
        allowedSeaDrop[0] = seaDrop;

        vm.startBroadcast();
        generator = new NekoGenerator();
        neko = new NekoPFP("0xNeko PFP", "NEKO", allowedSeaDrop, generator, commitment);
        neko.updateCreatorPayoutAddress(seaDrop, payout);
        neko.updateAllowedFeeRecipient(seaDrop, feeRecipient, true);
        vm.stopBroadcast();
    }
}
