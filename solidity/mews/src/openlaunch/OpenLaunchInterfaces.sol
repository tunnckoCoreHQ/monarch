// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

// Subset of the OpenLaunch contracts on Base used by Mews. The factory is at
// 0x815542E8b392389A1389E22E588E4B62A67Ade72 and the locker at
// 0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a.

struct Recipient {
    address payout;
    uint16 bps;
}

struct LaunchParams {
    string name;
    string symbol;
    string metadataURI;
    address quote;
    uint256 supply;
    int24 startTick;
    uint24 lpFee;
    bytes32 salt;
    Recipient[] recipients;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface ILaunchLocker {
    function tokenIdOf(address token) external view returns (uint256);
    function claimable(address account, address currency) external view returns (uint256);
    function collect(uint256 tokenId) external returns (uint256 quoteOut, uint256 tokenOut);
}

interface ILaunchFactory {
    function launch(LaunchParams calldata params) external returns (address token, uint256 tokenId);
    function findSalt(
        address launcher,
        bytes32 baseSalt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        string calldata metadataURI,
        address quote,
        uint256 maxTries
    ) external view returns (bytes32 salt, address token);
    function poolKeyOf(address token) external view returns (PoolKey memory);
}
