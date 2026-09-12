// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {MewsForwarder} from "../src/MewsForwarder.sol";
import {ILaunchFactory, LaunchParams, Recipient} from "../src/openlaunch/OpenLaunchInterfaces.sol";

interface IPriceFeed {
    function latestRoundData()
        external
        view
        returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80);
}

contract DeployForwarder is Script {
    error InvalidConfiguration();
    error InvalidDeployerKey();
    error InvalidPrice();
    error StalePrice();
    error UnexpectedToken();

    ILaunchFactory internal constant FACTORY =
        ILaunchFactory(0x815542E8b392389A1389E22E588E4B62A67Ade72);
    // Chainlink ETH / USD on Base, 8 decimals.
    IPriceFeed internal constant ETH_USD = IPriceFeed(0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70);
    address internal constant MEWS = 0x41c11fc8169a3051BCab720c7f5e16BaE1Bd3db8;
    address internal constant AUTOMATION = 0x9d703681dEe601B971F2FE8576B4f8020c145099;
    address internal constant ACCOUNT = 0x8948da17f04ae9c83dD1fc78976D02cA4e9C7a8e;
    address internal constant DEPLOYER = 0x6C22d03544609Db5128736706d90D66fC7f45388;
    address internal constant QUOTE = address(0);
    int256 internal constant SUPPLY = 1_000_000_000;
    int256 internal constant CAP_USD = 100_000;
    uint24 internal constant LP_FEE = 30_000;
    int256 internal constant TICK_SPACING = 200;

    // PRIVATE_KEY is loaded from the project's .env file. The token address is predicted from
    // the launch parameters, so the forwarder can be its recipient before the token exists.
    // The opening price is the USD cap converted with the current ETH price.
    function run(string calldata name, string calldata symbol, string calldata metadataURI)
        external
        returns (MewsForwarder forwarder, address token)
    {
        if (block.chainid != 8453) {
            revert InvalidConfiguration();
        }
        (LaunchParams memory params, address predicted) = _plan(name, symbol, metadataURI);

        _startBroadcast();
        forwarder = new MewsForwarder(FACTORY, predicted, MEWS, ACCOUNT, AUTOMATION);
        params.recipients = new Recipient[](1);
        params.recipients[0] = Recipient(address(forwarder), 10_000);
        (token,) = FACTORY.launch(params);
        vm.stopBroadcast();

        if (token != predicted) {
            revert UnexpectedToken();
        }
    }

    // Tokens per ETH at the cap, as the pool tick: price = 1.0001^tick, snapped down to the
    // tick spacing so the cap rounds up slightly, like the OpenLaunch site does.
    function startTick() public view returns (int24) {
        (, int256 ethUsd,, uint256 updatedAt,) = ETH_USD.latestRoundData();
        if (ethUsd <= 0) {
            revert InvalidPrice();
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - updatedAt > 1 hours) {
            revert StalePrice();
        }
        int256 tokensPerEth = SUPPLY * ethUsd * 1e18 / (CAP_USD * 1e8);
        int256 tick = FixedPointMathLib.lnWad(tokensPerEth) / FixedPointMathLib.lnWad(1.0001e18);
        return SafeCastLib.toInt24(tick - tick % TICK_SPACING);
    }

    function _plan(string calldata name, string calldata symbol, string calldata metadataURI)
        internal
        view
        returns (LaunchParams memory params, address predicted)
    {
        params.name = name;
        params.symbol = symbol;
        params.metadataURI = metadataURI;
        params.quote = QUOTE;
        params.startTick = startTick();
        params.lpFee = LP_FEE;
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
