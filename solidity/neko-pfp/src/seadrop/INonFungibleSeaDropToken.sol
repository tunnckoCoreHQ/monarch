// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {ISeaDropTokenContractMetadata} from "./ISeaDropTokenContractMetadata.sol";
import {
    AllowListData,
    PublicDrop,
    SignedMintValidationParams,
    TokenGatedDropStage
} from "./SeaDropStructs.sol";

/// @notice The interface deployed SeaDrop expects the NFT contract to implement. Function
///         selectors are ABI-identical to the upstream `INonFungibleSeaDropToken`, so
///         `type(INonFungibleSeaDropToken).interfaceId` resolves to the same value SeaDrop
///         checks via `IERC165.supportsInterface` before accepting any config call.
interface INonFungibleSeaDropToken is ISeaDropTokenContractMetadata {
    error OnlyAllowedSeaDrop();

    event AllowedSeaDropUpdated(address[] allowedSeaDrop);

    function updateAllowedSeaDrop(address[] calldata allowedSeaDrop) external;

    function mintSeaDrop(address minter, uint256 quantity) external;

    function getMintStats(address minter)
        external
        view
        returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply);

    function updatePublicDrop(address seaDropImpl, PublicDrop calldata publicDrop) external;

    function updateAllowList(address seaDropImpl, AllowListData calldata allowListData) external;

    function updateTokenGatedDrop(
        address seaDropImpl,
        address allowedNftToken,
        TokenGatedDropStage calldata dropStage
    ) external;

    function updateDropURI(address seaDropImpl, string calldata dropURI) external;

    function updateCreatorPayoutAddress(address seaDropImpl, address payoutAddress) external;

    function updateAllowedFeeRecipient(address seaDropImpl, address feeRecipient, bool allowed)
        external;

    function updateSignedMintValidationParams(
        address seaDropImpl,
        address signer,
        SignedMintValidationParams calldata signedMintValidationParams
    ) external;

    function updatePayer(address seaDropImpl, address payer, bool allowed) external;
}
