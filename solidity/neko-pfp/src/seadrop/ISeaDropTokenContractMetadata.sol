// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

/// @notice ERC-2981 royalty info standard, re-declared to avoid vendoring OpenZeppelin.
interface IERC2981 {
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount);
}

/// @notice The token metadata surface SeaDrop tokens must expose. Selectors and struct layout
///         are ABI-identical to the deployed `ISeaDropTokenContractMetadata` so ERC-165
///         `interfaceId` computation matches.
interface ISeaDropTokenContractMetadata is IERC2981 {
    error CannotExceedMaxSupplyOfUint64(uint256 newMaxSupply);
    error NewMaxSupplyCannotBeLessThenTotalMinted(uint256 got, uint256 totalMinted);
    error ProvenanceHashCannotBeSetAfterMintStarted();
    error InvalidRoyaltyBasisPoints(uint256 basisPoints);
    error RoyaltyAddressCannotBeZeroAddress();

    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event ContractURIUpdated(string newContractURI);
    event MaxSupplyUpdated(uint256 newMaxSupply);
    event ProvenanceHashUpdated(bytes32 previousHash, bytes32 newHash);
    event RoyaltyInfoUpdated(address receiver, uint256 bps);

    struct RoyaltyInfo {
        address royaltyAddress;
        uint96 royaltyBps;
    }

    function setBaseURI(string calldata tokenURI) external;

    function setContractURI(string calldata newContractURI) external;

    function setMaxSupply(uint256 newMaxSupply) external;

    function setProvenanceHash(bytes32 newProvenanceHash) external;

    function setRoyaltyInfo(RoyaltyInfo calldata newInfo) external;

    function baseURI() external view returns (string memory);

    function contractURI() external view returns (string memory);

    function maxSupply() external view returns (uint256);

    function provenanceHash() external view returns (bytes32);

    function royaltyAddress() external view returns (address);

    function royaltyBasisPoints() external view returns (uint256);
}
