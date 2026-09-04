// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {ERC721A} from "erc721a/ERC721A.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

import {INonFungibleSeaDropToken} from "./INonFungibleSeaDropToken.sol";
import {IERC2981, ISeaDropTokenContractMetadata} from "./ISeaDropTokenContractMetadata.sol";
import {ISeaDrop} from "./ISeaDrop.sol";
import {
    AllowListData,
    PublicDrop,
    SignedMintValidationParams,
    TokenGatedDropStage
} from "./SeaDropStructs.sol";

/// @notice ERC-721A drop token compatible with the deployed OpenSea SeaDrop protocol.
///         Handles the full `INonFungibleSeaDropToken` surface: allowed-SeaDrop registry,
///         `mintSeaDrop`/`getMintStats` mint API, ERC-2981 royalties, provenance hash,
///         and owner-gated passthroughs that forward stage configuration to the SeaDrop
///         protocol contract with the token itself as `msg.sender`.
///
///         There is no public burn. Tokens leave circulation only through paths the
///         inheriting contract opens itself with the internal `_burn`.
abstract contract ERC721SeaDropCompat is
    ERC721A,
    Ownable,
    ReentrancyGuard,
    INonFungibleSeaDropToken
{
    error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply);

    /// @dev OpenSea fee basis points cap enforced by SeaDrop; kept here as the natural bound.
    uint256 private constant BPS_DENOMINATOR = 10_000;
    /// @dev ERC-721A packs supply into uint64.
    uint256 private constant MAX_SUPPLY_LIMIT = type(uint64).max;

    string public baseURI;
    string public contractURI;
    uint256 public maxSupply;
    bytes32 public provenanceHash;

    RoyaltyInfo internal _royaltyInfo;
    mapping(address => bool) internal _allowedSeaDrop;
    address[] internal _enumeratedAllowedSeaDrop;

    constructor(string memory name_, string memory symbol_, address[] memory allowedSeaDrop_)
        ERC721A(name_, symbol_)
    {
        _initializeOwner(msg.sender);
        _setAllowedSeaDrop(allowedSeaDrop_);
    }

    // ------------------------------------------------------------------
    // Minting (called by SeaDrop)
    // ------------------------------------------------------------------

    /// @inheritdoc INonFungibleSeaDropToken
    function mintSeaDrop(address minter, uint256 quantity) external virtual override nonReentrant {
        _onlyAllowedSeaDrop(msg.sender);

        uint256 total = _totalMinted() + quantity;
        if (total > maxSupply) {
            revert MintQuantityExceedsMaxSupply(total, maxSupply);
        }

        _safeMint(minter, quantity);
    }

    /// @inheritdoc INonFungibleSeaDropToken
    function getMintStats(address minter)
        external
        view
        virtual
        override
        returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply_)
    {
        minterNumMinted = _numberMinted(minter);
        currentTotalSupply = _totalMinted();
        maxSupply_ = maxSupply;
    }

    // ------------------------------------------------------------------
    // Allowed SeaDrop registry
    // ------------------------------------------------------------------

    /// @inheritdoc INonFungibleSeaDropToken
    function updateAllowedSeaDrop(address[] calldata allowedSeaDrop_) external override onlyOwner {
        _setAllowedSeaDrop(allowedSeaDrop_);
    }

    // ------------------------------------------------------------------
    // Token contract metadata (ISeaDropTokenContractMetadata)
    // ------------------------------------------------------------------

    /// @notice Stored for `INonFungibleSeaDropToken` compliance. This contract's `tokenURI`
    ///         is generated on-chain and ignores `baseURI`; the setter exists so tools that
    ///         expect the standard SeaDrop surface can still call it and refresh metadata.
    function setBaseURI(string calldata newBaseURI) external override onlyOwner {
        baseURI = newBaseURI;
        emit BatchMetadataUpdate(_startTokenId(), _totalMinted());
    }

    function setContractURI(string calldata newContractURI) external override onlyOwner {
        contractURI = newContractURI;
        emit ContractURIUpdated(newContractURI);
    }

    function setMaxSupply(uint256 newMaxSupply) external override onlyOwner {
        if (newMaxSupply > MAX_SUPPLY_LIMIT) {
            revert CannotExceedMaxSupplyOfUint64(newMaxSupply);
        }
        if (newMaxSupply < _totalMinted()) {
            revert NewMaxSupplyCannotBeLessThenTotalMinted(newMaxSupply, _totalMinted());
        }

        maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(newMaxSupply);
    }

    function setProvenanceHash(bytes32 newProvenanceHash) external virtual override onlyOwner {
        if (_totalMinted() > 0) {
            revert ProvenanceHashCannotBeSetAfterMintStarted();
        }

        bytes32 previous = provenanceHash;
        provenanceHash = newProvenanceHash;
        emit ProvenanceHashUpdated(previous, newProvenanceHash);
    }

    function setRoyaltyInfo(RoyaltyInfo calldata newInfo) external override onlyOwner {
        if (newInfo.royaltyAddress == address(0)) {
            revert RoyaltyAddressCannotBeZeroAddress();
        }
        if (newInfo.royaltyBps > BPS_DENOMINATOR) {
            revert InvalidRoyaltyBasisPoints(newInfo.royaltyBps);
        }

        _royaltyInfo = newInfo;
        emit RoyaltyInfoUpdated(newInfo.royaltyAddress, newInfo.royaltyBps);
    }

    function royaltyAddress() external view override returns (address) {
        return _royaltyInfo.royaltyAddress;
    }

    function royaltyBasisPoints() external view override returns (uint256) {
        return _royaltyInfo.royaltyBps;
    }

    /// @inheritdoc IERC2981
    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        receiver = _royaltyInfo.royaltyAddress;
        royaltyAmount = (salePrice * _royaltyInfo.royaltyBps) / BPS_DENOMINATOR;
    }

    // ------------------------------------------------------------------
    // Owner-gated passthroughs to the SeaDrop protocol
    // ------------------------------------------------------------------

    function updatePublicDrop(address seaDropImpl, PublicDrop calldata publicDrop)
        external
        override
        onlyOwner
    {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updatePublicDrop(publicDrop);
    }

    function updateAllowList(address seaDropImpl, AllowListData calldata allowListData)
        external
        override
        onlyOwner
    {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updateAllowList(allowListData);
    }

    function updateTokenGatedDrop(
        address seaDropImpl,
        address allowedNftToken,
        TokenGatedDropStage calldata dropStage
    ) external override onlyOwner {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updateTokenGatedDrop(allowedNftToken, dropStage);
    }

    function updateDropURI(address seaDropImpl, string calldata dropURI)
        external
        override
        onlyOwner
    {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updateDropURI(dropURI);
    }

    function updateCreatorPayoutAddress(address seaDropImpl, address payoutAddress)
        external
        override
        onlyOwner
    {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updateCreatorPayoutAddress(payoutAddress);
    }

    function updateAllowedFeeRecipient(address seaDropImpl, address feeRecipient, bool allowed)
        external
        override
        onlyOwner
    {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updateAllowedFeeRecipient(feeRecipient, allowed);
    }

    function updateSignedMintValidationParams(
        address seaDropImpl,
        address signer,
        SignedMintValidationParams calldata signedMintValidationParams
    ) external override onlyOwner {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updateSignedMintValidationParams(signer, signedMintValidationParams);
    }

    function updatePayer(address seaDropImpl, address payer, bool allowed)
        external
        override
        onlyOwner
    {
        _onlyAllowedSeaDrop(seaDropImpl);
        ISeaDrop(seaDropImpl).updatePayer(payer, allowed);
    }

    // ------------------------------------------------------------------
    // ERC-165
    // ------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721A)
        returns (bool)
    {
        return interfaceId == type(INonFungibleSeaDropToken).interfaceId
            || interfaceId == type(ISeaDropTokenContractMetadata).interfaceId
            || interfaceId == type(IERC2981).interfaceId || interfaceId == 0x49064906 // ERC-4906
            || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _onlyAllowedSeaDrop(address seaDropImpl) internal view {
        if (!_allowedSeaDrop[seaDropImpl]) {
            revert OnlyAllowedSeaDrop();
        }
    }

    function _setAllowedSeaDrop(address[] memory allowedSeaDrop_) internal {
        address[] memory previous = _enumeratedAllowedSeaDrop;
        for (uint256 i; i < previous.length; ++i) {
            _allowedSeaDrop[previous[i]] = false;
        }
        for (uint256 i; i < allowedSeaDrop_.length; ++i) {
            _allowedSeaDrop[allowedSeaDrop_[i]] = true;
        }

        _enumeratedAllowedSeaDrop = allowedSeaDrop_;
        emit AllowedSeaDropUpdated(allowedSeaDrop_);
    }
}
