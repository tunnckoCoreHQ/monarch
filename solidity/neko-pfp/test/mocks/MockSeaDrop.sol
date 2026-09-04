// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {ISeaDrop} from "../../src/seadrop/ISeaDrop.sol";
import {
    AllowListData,
    PublicDrop,
    SignedMintValidationParams,
    TokenGatedDropStage
} from "../../src/seadrop/SeaDropStructs.sol";

/// @notice Minimal `ISeaDrop` that records the caller and the last args for each update,
///         so tests can prove the token's passthroughs forward the exact call verbatim.
contract MockSeaDrop is ISeaDrop {
    struct Call {
        address caller;
        bytes data;
    }

    mapping(bytes4 => Call) public lastCall;

    function updatePublicDrop(PublicDrop calldata publicDrop) external override {
        lastCall[this.updatePublicDrop.selector] = Call(msg.sender, abi.encode(publicDrop));
    }

    function updateAllowList(AllowListData calldata allowListData) external override {
        lastCall[this.updateAllowList.selector] = Call(msg.sender, abi.encode(allowListData));
    }

    function updateTokenGatedDrop(address allowedNftToken, TokenGatedDropStage calldata dropStage)
        external
        override
    {
        lastCall[this.updateTokenGatedDrop.selector] =
            Call(msg.sender, abi.encode(allowedNftToken, dropStage));
    }

    function updateDropURI(string calldata dropURI) external override {
        lastCall[this.updateDropURI.selector] = Call(msg.sender, abi.encode(dropURI));
    }

    function updateCreatorPayoutAddress(address payoutAddress) external override {
        lastCall[this.updateCreatorPayoutAddress.selector] =
            Call(msg.sender, abi.encode(payoutAddress));
    }

    function updateAllowedFeeRecipient(address feeRecipient, bool allowed) external override {
        lastCall[this.updateAllowedFeeRecipient.selector] =
            Call(msg.sender, abi.encode(feeRecipient, allowed));
    }

    function updateSignedMintValidationParams(
        address signer,
        SignedMintValidationParams calldata signedMintValidationParams
    ) external override {
        lastCall[
            this.updateSignedMintValidationParams.selector
        ] = Call(msg.sender, abi.encode(signer, signedMintValidationParams));
    }

    function updatePayer(address payer, bool allowed) external override {
        lastCall[this.updatePayer.selector] = Call(msg.sender, abi.encode(payer, allowed));
    }

    function callerOf(bytes4 selector) external view returns (address) {
        return lastCall[selector].caller;
    }

    function dataOf(bytes4 selector) external view returns (bytes memory) {
        return lastCall[selector].data;
    }
}
