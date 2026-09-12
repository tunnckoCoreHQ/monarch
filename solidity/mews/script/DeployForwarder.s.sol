// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {MewsForwarder} from "../src/MewsForwarder.sol";
import {ILaunchFactory, LaunchParams, Recipient} from "../src/openlaunch/OpenLaunchInterfaces.sol";

contract DeployForwarder is Script {
    error InvalidConfiguration();
    error InvalidDeployerKey();
    error UnexpectedToken();

    ILaunchFactory internal constant FACTORY =
        ILaunchFactory(0x815542E8b392389A1389E22E588E4B62A67Ade72);
    address internal constant MEWS = 0x41c11fc8169a3051BCab720c7f5e16BaE1Bd3db8;
    address internal constant ACCOUNT = 0x8948da17f04ae9c83dD1fc78976D02cA4e9C7a8e;
    address internal constant DEPLOYER = 0x6C22d03544609Db5128736706d90D66fC7f45388;

    // PRIVATE_KEY is loaded from the project's .env file. The token address is predicted from
    // the launch parameters, so the forwarder can be its recipient before the token exists.
    address internal constant QUOTE = address(0);

    function run(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        int24 startTick,
        uint24 lpFee
    ) external returns (MewsForwarder forwarder, address token) {
        if (block.chainid != 8453) {
            revert InvalidConfiguration();
        }
        (LaunchParams memory params, address predicted) =
            _plan(name, symbol, metadataURI, startTick, lpFee);

        _startBroadcast();
        forwarder = new MewsForwarder(FACTORY, predicted, MEWS, ACCOUNT);
        params.recipients = new Recipient[](1);
        params.recipients[0] = Recipient(address(forwarder), 10_000);
        (token,) = FACTORY.launch(params);
        vm.stopBroadcast();

        if (token != predicted) {
            revert UnexpectedToken();
        }
    }

    function _plan(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        int24 startTick,
        uint24 lpFee
    ) internal view returns (LaunchParams memory params, address predicted) {
        params.name = name;
        params.symbol = symbol;
        params.metadataURI = metadataURI;
        params.quote = QUOTE;
        params.startTick = startTick;
        params.lpFee = lpFee;
        (params.salt, predicted) = FACTORY.findSalt(
            DEPLOYER, keccak256(bytes(symbol)), name, symbol, 0, metadataURI, QUOTE, 16
        );
    }

    function _startBroadcast() internal virtual {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        if (privateKey == 0 || vm.addr(privateKey) != DEPLOYER) {
            revert InvalidDeployerKey();
        }
        vm.startBroadcast(privateKey);
    }
}
