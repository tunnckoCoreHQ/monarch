// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {
    AllowListData,
    PublicDrop,
    SignedMintValidationParams,
    TokenGatedDropStage
} from "./SeaDropStructs.sol";

/// @notice The subset of the deployed SeaDrop protocol contract our token calls back to configure
///         its mint stages. SeaDrop gates every one of these on
///         `msg.sender.supportsInterface(type(INonFungibleSeaDropToken).interfaceId)`, so we call
///         them from the token itself (never from an EOA) via the owner-gated passthroughs.
interface ISeaDrop {
    function updatePublicDrop(PublicDrop calldata publicDrop) external;

    function updateAllowList(AllowListData calldata allowListData) external;

    function updateTokenGatedDrop(address allowedNftToken, TokenGatedDropStage calldata dropStage)
        external;

    function updateDropURI(string calldata dropURI) external;

    function updateCreatorPayoutAddress(address payoutAddress) external;

    function updateAllowedFeeRecipient(address feeRecipient, bool allowed) external;

    function updateSignedMintValidationParams(
        address signer,
        SignedMintValidationParams calldata signedMintValidationParams
    ) external;

    function updatePayer(address payer, bool allowed) external;
}
