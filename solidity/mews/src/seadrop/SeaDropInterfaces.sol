// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// SeaDrop ABI, verified against ProjectOpenSea/seadrop at 757590f11babfd81f4608f736e79e388469377f2.
struct PublicDrop {
    uint80 mintPrice;
    uint48 startTime;
    uint48 endTime;
    uint16 maxTotalMintableByWallet;
    uint16 feeBps;
    bool restrictFeeRecipients;
}

struct AllowListData {
    bytes32 merkleRoot;
    string[] publicKeyURIs;
    string allowListURI;
}

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

struct SignedMintValidationParams {
    uint80 minMintPrice;
    uint24 maxMaxTotalMintableByWallet;
    uint40 minStartTime;
    uint40 maxEndTime;
    uint40 maxMaxTokenSupplyForStage;
    uint16 minFeeBps;
    uint16 maxFeeBps;
}

struct MintParams {
    uint256 mintPrice;
    uint256 maxTotalMintableByWallet;
    uint256 startTime;
    uint256 endTime;
    uint256 dropStageIndex;
    uint256 maxTokenSupplyForStage;
    uint256 feeBps;
    bool restrictFeeRecipients;
}

struct TokenGatedMintParams {
    address allowedNftToken;
    uint256[] allowedNftTokenIds;
}

interface IERC2981 {
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address, uint256);
}

interface ISeaDropTokenContractMetadata is IERC2981 {
    error CannotExceedMaxSupplyOfUint64(uint256 newMaxSupply);
    error NewMaxSupplyCannotBeLessThenTotalMinted(uint256 got, uint256 totalMinted);
    error ProvenanceHashCannotBeSetAfterMintStarted();
    error InvalidRoyaltyBasisPoints(uint256 basisPoints);
    error RoyaltyAddressCannotBeZeroAddress();

    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
    event ContractURIUpdated(string newContractURI);
    event MaxSupplyUpdated(uint256 newMaxSupply);
    event ProvenanceHashUpdated(bytes32 previousHash, bytes32 newHash);
    event RoyaltyInfoUpdated(address receiver, uint256 bps);

    struct RoyaltyInfo {
        address royaltyAddress;
        uint96 royaltyBps;
    }

    function setBaseURI(string calldata uri) external;
    function setContractURI(string calldata uri) external;
    function setMaxSupply(uint256 supply) external;
    function setProvenanceHash(bytes32 hash) external;
    function setRoyaltyInfo(RoyaltyInfo calldata info) external;
    function baseURI() external view returns (string memory);
    function contractURI() external view returns (string memory);
    function maxSupply() external view returns (uint256);
    function provenanceHash() external view returns (bytes32);
    function royaltyAddress() external view returns (address);
    function royaltyBasisPoints() external view returns (uint256);
}

interface INonFungibleSeaDropToken is ISeaDropTokenContractMetadata {
    error OnlyAllowedSeaDrop();
    event AllowedSeaDropUpdated(address[] allowedSeaDrop);

    function updateAllowedSeaDrop(address[] calldata allowedSeaDrop) external;
    function mintSeaDrop(address minter, uint256 quantity) external;
    function getMintStats(address minter) external view returns (uint256, uint256, uint256);
    function updatePublicDrop(address seaDrop, PublicDrop calldata drop) external;
    function updateAllowList(address seaDrop, AllowListData calldata data) external;
    function updateTokenGatedDrop(
        address seaDrop,
        address token,
        TokenGatedDropStage calldata stage
    ) external;
    function updateDropURI(address seaDrop, string calldata uri) external;
    function updateCreatorPayoutAddress(address seaDrop, address recipient) external;
    function updateAllowedFeeRecipient(address seaDrop, address recipient, bool allowed) external;
    function updateSignedMintValidationParams(
        address seaDrop,
        address signer,
        SignedMintValidationParams calldata params
    ) external;
    function updatePayer(address seaDrop, address payer, bool allowed) external;
}

interface ISeaDrop {
    error NotActive(uint256 currentTimestamp, uint256 startTimestamp, uint256 endTimestamp);
    error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed);
    error MintQuantityExceedsMaxSupply(uint256 total, uint256 maxSupply);
    error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total, uint256 maxSupply);
    error IncorrectPayment(uint256 got, uint256 want);
    error FeeRecipientNotAllowed();
    error PayerNotAllowed();
    error InvalidProof();
    error SignatureAlreadyUsed();
    error TokenGatedTokenIdAlreadyRedeemed(address nft, address allowedNftToken, uint256 tokenId);

    function mintPublic(
        address nft,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity
    ) external payable;
    function mintAllowList(
        address nft,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity,
        MintParams calldata params,
        bytes32[] calldata proof
    ) external payable;
    function mintSigned(
        address nft,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity,
        MintParams calldata params,
        uint256 salt,
        bytes calldata signature
    ) external payable;
    function mintAllowedTokenHolder(
        address nft,
        address feeRecipient,
        address minterIfNotPayer,
        TokenGatedMintParams calldata params
    ) external payable;
    function updatePublicDrop(PublicDrop calldata drop) external;
    function updateAllowList(AllowListData calldata data) external;
    function updateTokenGatedDrop(address token, TokenGatedDropStage calldata stage) external;
    function updateDropURI(string calldata uri) external;
    function updateCreatorPayoutAddress(address recipient) external;
    function updateAllowedFeeRecipient(address recipient, bool allowed) external;
    function updateSignedMintValidationParams(
        address signer,
        SignedMintValidationParams calldata params
    ) external;
    function updatePayer(address payer, bool allowed) external;
    function getPublicDrop(address nft) external view returns (PublicDrop memory);
    function getCreatorPayoutAddress(address nft) external view returns (address);
}
