// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";

import {NekoPFP} from "../src/NekoPFP.sol";
import {AllowListData, PublicDrop} from "../src/seadrop/SeaDropStructs.sol";

/// @notice Configures the two mint phases on SeaDrop. Run each entrypoint with --sig.
///
///         Allowlist phase (3 free mints per wallet; root built by
///         scripts/allowlist-merkle.ts):
///           NEKO=<token> MERKLE_ROOT=<root> ALLOWLIST_URI=<uri> \
///           forge script script/ConfigureDrop.s.sol --sig "allowlist()" \
///             --rpc-url $RPC_URL --private-key $PK --broadcast
///
///         Public phase (regular price, lifetime cap 10 per wallet, placeholder
///         until the global cap is decided):
///           NEKO=<token> PUBLIC_PRICE_WEI=<wei> START_TIME=<unix> END_TIME=<unix> \
///           forge script script/ConfigureDrop.s.sol --sig "publicDrop()" \
///             --rpc-url $RPC_URL --private-key $PK --broadcast
contract ConfigureDrop is Script {
    address internal constant CANONICAL_SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;

    /// @dev Lifetime per-wallet cap for the public phase; placeholder until decided.
    ///      SeaDrop caps count all mints the wallet ever made, so this includes the
    ///      3 free allowlist mints.
    uint16 internal constant PUBLIC_MAX_PER_WALLET = 10;
    /// @dev OpenSea's primary drop fee: 10%.
    uint16 internal constant OPENSEA_FEE_BPS = 1000;

    function allowlist() external {
        NekoPFP neko = NekoPFP(vm.envAddress("NEKO"));
        address seaDrop = vm.envOr("SEADROP", CANONICAL_SEADROP);

        AllowListData memory data = AllowListData({
            merkleRoot: vm.envBytes32("MERKLE_ROOT"),
            publicKeyURIs: new string[](0),
            allowListURI: vm.envString("ALLOWLIST_URI")
        });

        vm.startBroadcast();
        neko.updateAllowList(seaDrop, data);
        vm.stopBroadcast();
    }

    function publicDrop() external {
        NekoPFP neko = NekoPFP(vm.envAddress("NEKO"));
        address seaDrop = vm.envOr("SEADROP", CANONICAL_SEADROP);

        PublicDrop memory drop = PublicDrop({
            mintPrice: uint80(vm.envUint("PUBLIC_PRICE_WEI")),
            startTime: uint48(vm.envUint("START_TIME")),
            endTime: uint48(vm.envUint("END_TIME")),
            maxTotalMintableByWallet: PUBLIC_MAX_PER_WALLET,
            feeBps: OPENSEA_FEE_BPS,
            restrictFeeRecipients: true
        });

        vm.startBroadcast();
        neko.updatePublicDrop(seaDrop, drop);
        vm.stopBroadcast();
    }
}
