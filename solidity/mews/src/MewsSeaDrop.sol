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
    MultiConfigureStruct
} from "./seadrop/SeaDropInterfaces.sol";

contract MewsSeaDrop is MewsArt, Ownable, IERC2981, ICreatorToken {
    error InvalidSeaDrop();
    error InvalidTransferValidator();
    error FixedMaxSupply();
    ISeaDrop public immutable seaDrop;
    string public contractURI;

    ISeaDropTokenContractMetadata.RoyaltyInfo private _royalty;
    address private _transferValidator;

    event SeaDropTokenDeployed();
    event RoyaltyInfoUpdated(address receiver, uint256 bps);
    event ContractURIUpdated(string newContractURI);
    event AllowedSeaDropUpdated(address[] allowedSeaDrop);

    constructor(bytes32 genesisSeed, MewsRenderer renderer_, ISeaDrop seaDrop_)
        MewsArt(genesisSeed, renderer_)
    {
        if (address(seaDrop_) == address(0)) {
            revert InvalidSeaDrop();
        }
        _initializeOwner(msg.sender);
        seaDrop = seaDrop_;
        _prepareMint(0x9D9db340778139774cF73DFB7Bf27498Fa67978F, 5);
        _mint(0x9D9db340778139774cF73DFB7Bf27498Fa67978F, 5);
        _prepareMint(0x6C22d03544609Db5128736706d90D66fC7f45388, 15);
        _mint(0x6C22d03544609Db5128736706d90D66fC7f45388, 15);
        address[] memory allowedSeaDrop = new address[](1);
        allowedSeaDrop[0] = address(seaDrop_);
        emit AllowedSeaDropUpdated(allowedSeaDrop);
        emit SeaDropTokenDeployed();
        emit ISeaDropTokenContractMetadata.MaxSupplyUpdated(MAX_SUPPLY);
    }

    function setContractURI(string memory uri) public onlyOwner {
        contractURI = uri;
        emit ContractURIUpdated(uri);
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

    function setMaxSupply(uint256 supply) public onlyOwner {
        if (supply != MAX_SUPPLY) {
            revert FixedMaxSupply();
        }
        // OpenSea indexes the supply event even when the cap is fixed.
        emit ISeaDropTokenContractMetadata.MaxSupplyUpdated(MAX_SUPPLY);
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

    function multiConfigure(MultiConfigureStruct calldata config) external onlyOwner {
        _checkSeaDrop(config.seaDropImpl);
        if (config.maxSupply != 0) {
            setMaxSupply(config.maxSupply);
        }
        setContractURI(
            string.concat(
                "data:application/json;base64,",
                Base64.encode(
                    bytes(
                        '{"name":"Mews","symbol":"MEWS","description":"Pixel-perfect pastel Mews, generated and rendered entirely on-chain.","collaborators":["0x9d9db340778139774cf73dfb7bf27498fa67978f","0x6c22d03544609db5128736706d90d66fc7f45388"]}'
                    )
                )
            )
        );
        if (config.publicDrop.startTime != 0 || config.publicDrop.endTime != 0) {
            seaDrop.updatePublicDrop(config.publicDrop);
        }
        if (bytes(config.dropURI).length != 0) {
            seaDrop.updateDropURI(config.dropURI);
        }
        if (config.allowListData.merkleRoot != bytes32(0)) {
            seaDrop.updateAllowList(config.allowListData);
        }
        if (config.creatorPayoutAddress != address(0)) {
            seaDrop.updateCreatorPayoutAddress(config.creatorPayoutAddress);
        }
        for (uint256 i; i < config.allowedFeeRecipients.length; ++i) {
            seaDrop.updateAllowedFeeRecipient(config.allowedFeeRecipients[i], true);
        }
        for (uint256 i; i < config.disallowedFeeRecipients.length; ++i) {
            seaDrop.updateAllowedFeeRecipient(config.disallowedFeeRecipients[i], false);
        }
        for (uint256 i; i < config.allowedPayers.length; ++i) {
            seaDrop.updatePayer(config.allowedPayers[i], true);
        }
        for (uint256 i; i < config.disallowedPayers.length; ++i) {
            seaDrop.updatePayer(config.disallowedPayers[i], false);
        }
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
