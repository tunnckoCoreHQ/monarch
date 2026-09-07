// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {MewsRenderer} from "../src/MewsRenderer.sol";
import {MewsSeaDrop} from "../src/MewsSeaDrop.sol";
import {
    ISeaDrop,
    ISeaDropTokenContractMetadata,
    PublicDrop,
    MintParams,
    AllowListData
} from "../src/seadrop/SeaDropInterfaces.sol";

contract Deploy is Script {
    using SafeCastLib for uint256;

    error InvalidConfiguration();

    address internal constant SEA_DROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant OPENSEA_FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address internal constant TRANSFER_VALIDATOR = 0xA000027A9B2802E1ddf7000061001e5c005A0000;
    address internal constant DEPLOYER = 0x6C22d03544609Db5128736706d90D66fC7f45388;
    bytes32 internal constant GENESIS_SEED =
        keccak256("Pixel-perfect pastel Mews, generated and rendered entirely on-chain.");

    // Sign with DEPLOYER's wallet. Dates can be overridden with
    // PRIVATE_START_TIME, START_TIME, END_TIME; defaults are documented below.
    // Run through `vp run --filter mews deploy --rpc-url <Base RPC>` for a dry run.
    // Forge accepts --interactive for a private-key prompt or --account for a keystore.
    function run()
        external
        returns (MewsRenderer renderer, MewsSeaDrop mews, MintParams memory creatorStage)
    {
        // Creator: Sep 7, 2026 at 21:50 UTC. Public: Sep 7 at 22:00 through Sep 21 at 22:00 UTC.
        uint256 privateStart = vm.envOr("PRIVATE_START_TIME", uint256(1_788_817_800));
        PublicDrop memory drop = PublicDrop({
            mintPrice: 0.000_42 ether,
            startTime: vm.envOr("START_TIME", uint256(1_788_818_400)).toUint48(),
            endTime: vm.envOr("END_TIME", uint256(1_790_028_000)).toUint48(),
            maxTotalMintableByWallet: 10,
            feeBps: 1000,
            restrictFeeRecipients: true
        });
        if (
            block.chainid != 8453 || privateStart >= drop.startTime
                || drop.endTime <= drop.startTime
        ) {
            revert InvalidConfiguration();
        }

        creatorStage = MintParams({
            mintPrice: 0,
            maxTotalMintableByWallet: 20,
            startTime: privateStart,
            endTime: uint256(drop.startTime) - 1,
            dropStageIndex: 1,
            // Twenty free tokens total, including the two constructor mints.
            maxTokenSupplyForStage: 20,
            feeBps: 0,
            restrictFeeRecipients: true
        });

        vm.startBroadcast(DEPLOYER);
        renderer = MewsRenderer(deployCode("MewsRenderer.sol:MewsRenderer"));
        mews = new MewsSeaDrop(GENESIS_SEED, renderer, ISeaDrop(SEA_DROP));
        mews.updateCreatorPayoutAddress(SEA_DROP, DEPLOYER);
        mews.updateAllowedFeeRecipient(SEA_DROP, OPENSEA_FEE_RECIPIENT, true);
        // A single allowlisted wallet has an empty Merkle proof.
        mews.updateAllowList(
            SEA_DROP,
            AllowListData(keccak256(abi.encode(mews.owner(), creatorStage)), new string[](0), "")
        );
        mews.setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo(DEPLOYER, 500));
        mews.setTransferValidator(TRANSFER_VALIDATOR);
        mews.updatePublicDrop(SEA_DROP, drop);
        vm.stopBroadcast();
    }
}
