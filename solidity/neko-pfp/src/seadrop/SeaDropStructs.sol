// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

/// @dev ABI-identical re-declarations of the deployed SeaDrop protocol's structs, pinned to this
///      project's compiler. Field order and widths must never change: they define the calldata
///      encoding and the `INonFungibleSeaDropToken` interface id that SeaDrop checks on-chain.

/// @notice Public drop data. Designed to fit in one storage slot.
/// @param mintPrice The mint price per token, in wei.
/// @param startTime The stage start time; must not be zero.
/// @param endTime The stage end time; must not be zero.
/// @param maxTotalMintableByWallet Maximum total mints allowed per wallet in this stage.
/// @param feeBps The OpenSea fee, out of 10_000 basis points.
/// @param restrictFeeRecipients If true, only allowed fee recipients may be used.
struct PublicDrop {
    uint80 mintPrice;
    uint48 startTime;
    uint48 endTime;
    uint16 maxTotalMintableByWallet;
    uint16 feeBps;
    bool restrictFeeRecipients;
}

/// @notice Token gated drop stage data. Designed to fit in one storage slot.
/// @param mintPrice The mint price per token, in wei.
/// @param maxTotalMintableByWallet Maximum total mints allowed per wallet in this stage.
/// @param startTime The stage start time; must not be zero.
/// @param endTime The stage end time; must not be zero.
/// @param dropStageIndex Non-zero stage index, emitted for analytics.
/// @param maxTokenSupplyForStage The token supply limit for this stage.
/// @param feeBps The OpenSea fee, out of 10_000 basis points.
/// @param restrictFeeRecipients If true, only allowed fee recipients may be used.
struct TokenGatedDropStage {
    uint80 mintPrice;
    uint16 maxTotalMintableByWallet;
    uint48 startTime;
    uint48 endTime;
    uint8 dropStageIndex;
    uint32 maxTokenSupplyForStage;
    uint16 feeBps;
    bool restrictFeeRecipients;
}

/// @notice Allow list data for an allow list mint stage.
/// @param merkleRoot The merkle root of the allow list.
/// @param publicKeyURIs URIs of the public keys if the allow list is encrypted; empty otherwise.
/// @param allowListURI The URI of the allow list.
struct AllowListData {
    bytes32 merkleRoot;
    string[] publicKeyURIs;
    string allowListURI;
}

/// @notice Bounds enforced on server-signed mints, limiting the damage of a compromised signer.
/// @param minMintPrice The minimum mint price allowed.
/// @param maxMaxTotalMintableByWallet The maximum per-wallet mint limit allowed.
/// @param minStartTime The earliest start time allowed.
/// @param maxEndTime The latest end time allowed.
/// @param maxMaxTokenSupplyForStage The maximum stage token supply allowed.
/// @param minFeeBps The minimum fee allowed.
/// @param maxFeeBps The maximum fee allowed.
struct SignedMintValidationParams {
    uint80 minMintPrice;
    uint24 maxMaxTotalMintableByWallet;
    uint40 minStartTime;
    uint40 maxEndTime;
    uint40 maxMaxTokenSupplyForStage;
    uint16 minFeeBps;
    uint16 maxFeeBps;
}
