// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Base64} from "solady/utils/Base64.sol";
import {MewsArt} from "./MewsArt.sol";
import {MewsRenderer} from "./MewsRenderer.sol";
import {ICreatorToken, ITransferValidator} from "./seadrop/TransferValidation.sol";
import {
    ISeaDrop,
    INonFungibleSeaDropToken,
    ISeaDropTokenContractMetadata,
    IERC2981,
    PublicDrop,
    AllowListData
} from "./seadrop/SeaDropInterfaces.sol";

contract MewsSeaDrop is MewsArt, Ownable, IERC2981, ICreatorToken {
    error InvalidSeaDrop();
    error ProvenanceHashImmutable();
    error InvalidTransferValidator();
    ISeaDrop public immutable seaDrop;
    string public contractURI;

    ISeaDropTokenContractMetadata.RoyaltyInfo private _royalty;
    address private _transferValidator;

    event SeaDropTokenDeployed();
    event RoyaltyInfoUpdated(address receiver, uint256 bps);
    event ContractURIUpdated();

    constructor(bytes32 genesisSeed, MewsRenderer renderer_, ISeaDrop seaDrop_)
        MewsArt(genesisSeed, renderer_)
    {
        if (address(seaDrop_) == address(0)) {
            revert InvalidSeaDrop();
        }
        _initializeOwner(msg.sender);
        seaDrop = seaDrop_;
        contractURI = string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    '{"name":"Mews","symbol":"MEWS","description":"Pixel-perfect pastel Mews, generated and rendered entirely on-chain.","collaborators":["0x9d9db340778139774cf73dfb7bf27498fa67978f","0x6c22d03544609db5128736706d90d66fc7f45388"]}'
                )
            )
        );
        _prepareMint(0x9D9db340778139774cF73DFB7Bf27498Fa67978F, 1);
        _mint(0x9D9db340778139774cF73DFB7Bf27498Fa67978F, 1);
        _prepareMint(0x6C22d03544609Db5128736706d90D66fC7f45388, 1);
        _mint(0x6C22d03544609Db5128736706d90D66fC7f45388, 1);
        emit SeaDropTokenDeployed();
    }

    function setContractURI(string calldata uri) external onlyOwner {
        contractURI = uri;
        emit ContractURIUpdated();
    }

    function mintSeaDrop(address minter, uint256 quantity) external nonReentrant {
        _checkSeaDrop(msg.sender);
        _mintCats(minter, quantity);
    }

    function getMintStats(address minter)
        external
        view
        returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maximum)
    {
        return (_numberMinted(minter), _totalMinted(), MAX_SUPPLY);
    }

    function maxSupply() external pure returns (uint256) {
        return MAX_SUPPLY;
    }

    function setProvenanceHash(bytes32) external pure {
        revert ProvenanceHashImmutable();
    }

    function setRoyaltyInfo(ISeaDropTokenContractMetadata.RoyaltyInfo calldata info)
        external
        onlyOwner
    {
        if (info.royaltyAddress == address(0)) {
            revert ISeaDropTokenContractMetadata.RoyaltyAddressCannotBeZeroAddress();
        }
        if (info.royaltyBps > 10_000) {
            revert ISeaDropTokenContractMetadata.InvalidRoyaltyBasisPoints(info.royaltyBps);
        }
        _royalty = info;
        emit RoyaltyInfoUpdated(info.royaltyAddress, info.royaltyBps);
    }

    function royaltyAddress() external view returns (address) {
        return _royalty.royaltyAddress;
    }

    function royaltyBasisPoints() external view returns (uint256) {
        return _royalty.royaltyBps;
    }

    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        override
        returns (address, uint256)
    {
        return (
            _royalty.royaltyAddress,
            FixedPointMathLib.fullMulDiv(salePrice, _royalty.royaltyBps, 10_000)
        );
    }

    function getTransferValidator() external view returns (address) {
        return _transferValidator;
    }

    function getTransferValidationFunction() external pure returns (bytes4, bool) {
        return (ITransferValidator.validateTransfer.selector, true);
    }

    function setTransferValidator(address validator) external onlyOwner {
        if (validator != address(0) && validator.code.length == 0) {
            revert InvalidTransferValidator();
        }
        address previous = _transferValidator;
        _transferValidator = validator;
        emit TransferValidatorUpdated(previous, validator);
    }

    function updatePublicDrop(address drop, PublicDrop calldata settings) external onlyOwner {
        _checkSeaDrop(drop);
        seaDrop.updatePublicDrop(settings);
    }

    function updateAllowList(address drop, AllowListData calldata settings) external onlyOwner {
        _checkSeaDrop(drop);
        seaDrop.updateAllowList(settings);
    }

    function updateCreatorPayoutAddress(address drop, address recipient) external onlyOwner {
        _checkSeaDrop(drop);
        seaDrop.updateCreatorPayoutAddress(recipient);
    }

    function updateAllowedFeeRecipient(address drop, address recipient, bool allowed)
        external
        onlyOwner
    {
        _checkSeaDrop(drop);
        seaDrop.updateAllowedFeeRecipient(recipient, allowed);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        // SeaDrop checks this compatibility ID before accepting drop configuration.
        return interfaceId == type(INonFungibleSeaDropToken).interfaceId
            || interfaceId == type(IERC2981).interfaceId
            || interfaceId == type(ICreatorToken).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function _beforeTokenTransfers(address from, address to, uint256 tokenId, uint256 quantity)
        internal
        view
        override
    {
        if (from == address(0) || to == address(0) || _transferValidator == address(0)) {
            return;
        }
        for (uint256 i; i < quantity; ++i) {
            ITransferValidator(_transferValidator)
                .validateTransfer(msg.sender, from, to, tokenId + i);
        }
    }

    function _checkSeaDrop(address drop) private view {
        if (drop != address(seaDrop)) {
            revert INonFungibleSeaDropToken.OnlyAllowedSeaDrop();
        }
    }
}
