// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {NekoGenerator} from "../src/NekoGenerator.sol";
import {NekoPFP} from "../src/NekoPFP.sol";
import {ISeaDrop, PublicDrop, MultiConfigureStruct} from "../src/seadrop/SeaDropInterfaces.sol";

/// @notice Throwaway probe: measures real `mintPublic` gas against the deployed SeaDrop
///         on a mainnet fork. Run with an RPC, never broadcast.
contract MintGasProbe is Script {
    address internal constant SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address internal constant OPENSEA_FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;

    function run() external {
        address payout = address(0xFA57);
        address minter = address(0x1337);
        vm.deal(minter, 10 ether);

        NekoGenerator generator = new NekoGenerator();
        NekoPFP neko = new NekoPFP(bytes32(uint256(1)), generator, ISeaDrop(SEADROP));

        MultiConfigureStruct memory config;
        config.seaDropImpl = SEADROP;
        config.creatorPayoutAddress = payout;
        config.allowedFeeRecipients = new address[](1);
        config.allowedFeeRecipients[0] = OPENSEA_FEE_RECIPIENT;
        config.publicDrop = PublicDrop({
            mintPrice: 0.01 ether,
            startTime: uint48(block.timestamp - 1),
            endTime: uint48(block.timestamp + 1 days),
            maxTotalMintableByWallet: 10,
            feeBps: 1000,
            restrictFeeRecipients: true
        });
        neko.multiConfigure(config);

        vm.startPrank(minter);
        uint256 gasBefore = gasleft();
        ISeaDrop(SEADROP).mintPublic{value: 0.01 ether}(
            address(neko), OPENSEA_FEE_RECIPIENT, address(0), 1
        );
        console.log("mintPublic qty 1, first mint:", gasBefore - gasleft());

        gasBefore = gasleft();
        ISeaDrop(SEADROP).mintPublic{value: 0.01 ether}(
            address(neko), OPENSEA_FEE_RECIPIENT, address(0), 1
        );
        console.log("mintPublic qty 1, warm wallet:", gasBefore - gasleft());

        gasBefore = gasleft();
        ISeaDrop(SEADROP).mintPublic{value: 0.05 ether}(
            address(neko), OPENSEA_FEE_RECIPIENT, address(0), 5
        );
        console.log("mintPublic qty 5:", gasBefore - gasleft());
        vm.stopPrank();
    }
}
