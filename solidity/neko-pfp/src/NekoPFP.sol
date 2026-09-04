// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {ERC721A} from "erc721a/ERC721A.sol";

import {INekoGenerator} from "./INekoGenerator.sol";
import {ERC721SeaDropCompat} from "./seadrop/ERC721SeaDropCompat.sol";

/// @title Neko PFP
/// @notice Fixed-supply Neko minting, committed reveal, deterministic quota-aware
///         token seeds, and the burn-based fusion game: duplicate merging, trait
///         mutation, fusion mass, and ancestry. The SeaDrop-facing mint API,
///         royalties, and passthroughs live in `ERC721SeaDropCompat`.
contract NekoPFP is ERC721SeaDropCompat {
    error GeneratorAddressIsZero();
    error IntendedSupplyExceeded(uint256 mintedBefore, uint256 quantity);
    error GenesisSeedCommitmentIsZero();
    error GenesisSeedAlreadyRevealed();
    error GenesisSeedNotRevealed();
    error GenesisSeedCommitmentMismatch(bytes32 expected, bytes32 actual);
    error ProvenanceHashImmutable();
    error MintNotComplete(uint256 minted, uint256 required);
    error SeedSamplingExhausted(uint256 tokenId, uint8 desiredClass);
    error CannotMergeTokenWithItself();
    error CannotMutateTokenWithItself();
    error MergeCallerNotOwnerNorApproved(uint256 tokenId);
    error MutationCallerNotOwnerNorApproved(uint256 tokenId);
    error CatSignatureMismatch(bytes32 survivorSignature, bytes32 consumedSignature);
    error CatSignatureMatch(bytes32 signature);
    error InvalidMutationSelectionMask(uint16 consumedPartsMask);
    error MutationHasNoEffect();

    enum FusionAction {
        DuplicateMerge,
        Mutation
    }

    struct AncestryNode {
        uint16 parentA;
        uint16 parentB;
        FusionAction action;
        uint16 mutationMask;
    }

    event GenesisSeedRevealed(bytes32 indexed genesisSeed);
    event CollectionUpdated(uint256 maxSupply, uint256 startBlock, bool open);
    /// @dev ERC-4906 single-token metadata update; `BatchMetadataUpdate` is inherited.
    event MetadataUpdate(uint256 _tokenId);
    event NekoMerged(
        uint256 indexed survivorTokenId, uint256 indexed consumedTokenId, uint256 newFusionMass
    );
    event AncestryCombined(
        uint256 indexed survivorTokenId,
        uint256 indexed consumedTokenId,
        uint16 indexed newRoot,
        FusionAction action,
        uint16 mutationMask,
        uint256 newFusionMass
    );

    uint256 public constant INTENDED_SUPPLY = 4663;
    uint256 public constant PRIMARY_COLOR_QUOTA = 96;

    uint256 private constant MAX_SEED_SAMPLING_ATTEMPTS = 512;
    uint8 private constant NON_QUOTA_CLASS = 0;
    uint8 private constant BLACK_CLASS = 1;
    uint8 private constant WHITE_CLASS = 2;
    uint8 private constant BLACK_BODY_INDEX = 16;
    uint8 private constant WHITE_BODY_INDEX = 17;
    uint16 private constant MUTATION_ALLOWED_MASK = 0x1fff;
    bytes32 private constant CLASS_PERMUTATION_DOMAIN =
        keccak256("NekoPFPSeaDrop.classPermutation.v1");
    bytes32 private constant TOKEN_SEED_DOMAIN = keccak256("NekoPFPSeaDrop.tokenSeed.v1");
    bytes32 private constant SEED_RETRY_DOMAIN = keccak256("NekoPFPSeaDrop.seedRetry.v1");
    bytes32 private constant GENESIS_SEED_COMMITMENT_DOMAIN =
        keccak256("NekoPFPSeaDrop.genesisSeedCommitment.v1");

    INekoGenerator public immutable generator;
    uint256 public immutable startBlock;
    bool public constant open = true;
    bytes32 public genesisSeed;
    bool public revealed;

    mapping(uint256 => uint16) public duplicateMergeCount;
    mapping(uint256 => uint16) public mutationCount;
    mapping(uint256 => uint16) public ancestryRoot;
    mapping(uint16 => AncestryNode) public ancestryNode;
    uint16 public nextNodeId = uint16(INTENDED_SUPPLY + 2);

    mapping(uint256 => bool) private _burnedToken;
    mapping(uint256 => uint256) private _fusionMassOverride;
    mapping(uint256 => bool) private _hasMutatedTraits;
    mapping(uint256 => INekoGenerator.RawTraits) private _mutatedTraits;

    modifier onlyRevealed() {
        if (!revealed) {
            revert GenesisSeedNotRevealed();
        }
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory allowedSeaDrop_,
        INekoGenerator generator_,
        bytes32 genesisSeedCommitment_
    ) ERC721SeaDropCompat(name_, symbol_, allowedSeaDrop_) {
        if (address(generator_) == address(0)) {
            revert GeneratorAddressIsZero();
        }
        if (genesisSeedCommitment_ == bytes32(0)) {
            revert GenesisSeedCommitmentIsZero();
        }

        generator = generator_;
        startBlock = block.number;

        maxSupply = INTENDED_SUPPLY;
        emit MaxSupplyUpdated(INTENDED_SUPPLY);

        // The seed commitment is stored in the SeaDrop-standard `provenanceHash` slot
        // and made immutable by overriding `setProvenanceHash` to always revert.
        provenanceHash = genesisSeedCommitment_;
        emit ProvenanceHashUpdated(bytes32(0), genesisSeedCommitment_);

        contractURI = string.concat(
            'data:application/json;utf8,{"name":"',
            name_,
            '","description":"Fully on-chain, pixel-perfect generative 0xNeko SVG art.","image":"',
            generator_.generateUnrevealedImageURI(),
            '"}'
        );

        emit ContractURIUpdated(contractURI);
        emit CollectionUpdated(INTENDED_SUPPLY, block.number, true);
    }

    // ------------------------------------------------------------------
    // Committed reveal and deterministic seeds
    // ------------------------------------------------------------------

    /// @notice The seed commitment lives in the inherited `provenanceHash` slot and is fixed at
    ///         deploy time; the SeaDrop-standard setter is disabled to preserve that guarantee.
    function setProvenanceHash(bytes32) external pure override {
        revert ProvenanceHashImmutable();
    }

    /// @notice Reveals the committed collection seed after all lifetime mints complete.
    function reveal(bytes32 seed) external onlyOwner {
        if (revealed) {
            revert GenesisSeedAlreadyRevealed();
        }

        uint256 minted = _totalMinted();
        if (minted != INTENDED_SUPPLY) {
            revert MintNotComplete(minted, INTENDED_SUPPLY);
        }

        bytes32 suppliedCommitment = keccak256(abi.encode(GENESIS_SEED_COMMITMENT_DOMAIN, seed));
        if (suppliedCommitment != provenanceHash) {
            revert GenesisSeedCommitmentMismatch(provenanceHash, suppliedCommitment);
        }

        genesisSeed = seed;
        revealed = true;

        emit GenesisSeedRevealed(seed);
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    /// @notice Derives a token seed from a candidate collection seed for offline verification.
    function deriveTokenSeed(bytes32 seed, uint256 tokenId) public view returns (uint256) {
        if (tokenId == 0 || tokenId > INTENDED_SUPPLY) {
            revert OwnerQueryForNonexistentToken();
        }

        return _sampleTokenSeed(seed, tokenId);
    }

    function seedOf(uint256 tokenId) public view returns (uint256) {
        if (!revealed || !_tokenExists(tokenId)) {
            return 0;
        }

        return deriveTokenSeed(genesisSeed, tokenId);
    }

    // ------------------------------------------------------------------
    // Token metadata
    // ------------------------------------------------------------------

    function tokenURI(uint256 tokenId)
        public
        view
        virtual
        override(ERC721A)
        returns (string memory)
    {
        if (!_tokenExists(tokenId)) {
            revert URIQueryForNonexistentToken();
        }
        if (!revealed) {
            return generator.generateUnrevealedTokenURI(tokenId);
        }

        uint256 seed = seedOf(tokenId);
        return generator.generateTokenURI(seed, tokenId, _resolveTokenData(tokenId, seed));
    }

    function tokenData(uint256 tokenId) public view returns (INekoGenerator.TokenData memory) {
        if (!_tokenExists(tokenId)) {
            revert URIQueryForNonexistentToken();
        }
        if (!revealed) {
            revert GenesisSeedNotRevealed();
        }

        return _resolveTokenData(tokenId);
    }

    // ------------------------------------------------------------------
    // Fusion: the burn game
    // ------------------------------------------------------------------

    function fusionMass(uint256 tokenId) public view returns (uint256) {
        if (!_tokenExists(tokenId)) {
            revert OwnerQueryForNonexistentToken();
        }

        return _effectiveFusionMass(tokenId);
    }

    function currentRoot(uint256 tokenId) public view returns (uint16) {
        if (tokenId == 0 || tokenId > _totalMinted() || tokenId > INTENDED_SUPPLY) {
            revert OwnerQueryForNonexistentToken();
        }

        uint16 storedRoot = ancestryRoot[tokenId];
        return storedRoot == 0 ? uint16(tokenId + 1) : storedRoot;
    }

    /// @notice Burns `consumedTokenId` into `survivorTokenId` when both cats match.
    function merge(uint256 survivorTokenId, uint256 consumedTokenId)
        external
        onlyRevealed
        nonReentrant
    {
        if (survivorTokenId == consumedTokenId) {
            revert CannotMergeTokenWithItself();
        }

        address sender = _msgSenderERC721A();
        _requireAuthorization(sender, survivorTokenId, false);
        _requireAuthorization(sender, consumedTokenId, false);

        INekoGenerator.TokenData memory survivorData = _resolveTokenData(survivorTokenId);
        INekoGenerator.TokenData memory consumedData = _resolveTokenData(consumedTokenId);
        bytes32 survivorSignature = generator.catSignature(survivorData.traits);
        bytes32 consumedSignature = generator.catSignature(consumedData.traits);
        if (survivorSignature != consumedSignature) {
            revert CatSignatureMismatch(survivorSignature, consumedSignature);
        }

        (uint16 newRoot, uint256 newMass) = _combineLiveState(
            survivorTokenId,
            consumedTokenId,
            FusionAction.DuplicateMerge,
            0,
            survivorData.fusionMass,
            consumedData.fusionMass
        );

        _burn(consumedTokenId, true);

        emit NekoMerged(survivorTokenId, consumedTokenId, newMass);
        emit AncestryCombined(
            survivorTokenId, consumedTokenId, newRoot, FusionAction.DuplicateMerge, 0, newMass
        );
        emit MetadataUpdate(survivorTokenId);
    }

    /// @notice Burns `consumedTokenId` and grafts its selected parts onto `survivorTokenId`.
    function mutate(uint256 survivorTokenId, uint256 consumedTokenId, uint16 consumedPartsMask)
        external
        onlyRevealed
        nonReentrant
    {
        if (survivorTokenId == consumedTokenId) {
            revert CannotMutateTokenWithItself();
        }

        address sender = _msgSenderERC721A();
        _requireAuthorization(sender, survivorTokenId, true);
        _requireAuthorization(sender, consumedTokenId, true);

        if (consumedPartsMask == 0 || (consumedPartsMask & ~MUTATION_ALLOWED_MASK) != 0) {
            revert InvalidMutationSelectionMask(consumedPartsMask);
        }

        INekoGenerator.TokenData memory survivorData = _resolveTokenData(survivorTokenId);
        INekoGenerator.TokenData memory consumedData = _resolveTokenData(consumedTokenId);
        bytes32 survivorSignature = generator.catSignature(survivorData.traits);
        bytes32 consumedSignature = generator.catSignature(consumedData.traits);
        if (survivorSignature == consumedSignature) {
            revert CatSignatureMatch(survivorSignature);
        }

        INekoGenerator.RawTraits memory combinedTraits =
            generator.combineRawTraits(survivorData.traits, consumedData.traits, consumedPartsMask);
        if (_rawTraitsEqual(survivorData.traits, combinedTraits)) {
            revert MutationHasNoEffect();
        }

        (uint16 newRoot, uint256 newMass) = _combineLiveState(
            survivorTokenId,
            consumedTokenId,
            FusionAction.Mutation,
            consumedPartsMask,
            survivorData.fusionMass,
            consumedData.fusionMass
        );
        _hasMutatedTraits[survivorTokenId] = true;
        _mutatedTraits[survivorTokenId] = combinedTraits;

        _burn(consumedTokenId, true);

        emit AncestryCombined(
            survivorTokenId,
            consumedTokenId,
            newRoot,
            FusionAction.Mutation,
            consumedPartsMask,
            newMass
        );
        emit MetadataUpdate(survivorTokenId);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function _beforeTokenTransfers(address from, address to, uint256 startTokenId, uint256 quantity)
        internal
        virtual
        override
    {
        super._beforeTokenTransfers(from, to, startTokenId, quantity);

        if (from == address(0)) {
            uint256 mintedBefore = _totalMinted();
            if (mintedBefore > INTENDED_SUPPLY || quantity > INTENDED_SUPPLY - mintedBefore) {
                revert IntendedSupplyExceeded(mintedBefore, quantity);
            }
            return;
        }
        if (to != address(0)) {
            return;
        }

        for (uint256 i; i < quantity; ++i) {
            _burnedToken[startTokenId + i] = true;
            _clearBurnedTokenState(startTokenId + i);
        }
    }

    /// @dev O(1) existence check. ERC721A's `_exists` walks back to the batch head,
    ///      which costs O(tokenId) reads after a single full-collection batch mint.
    function _tokenExists(uint256 tokenId) internal view returns (bool) {
        return tokenId != 0 && tokenId <= _totalMinted() && !_burnedToken[tokenId];
    }

    function _resolveTokenData(uint256 tokenId)
        internal
        view
        returns (INekoGenerator.TokenData memory)
    {
        return _resolveTokenData(tokenId, seedOf(tokenId));
    }

    function _resolveTokenData(uint256 tokenId, uint256 seed)
        internal
        view
        returns (INekoGenerator.TokenData memory)
    {
        if (!revealed) {
            revert GenesisSeedNotRevealed();
        }

        return generator.resolveTokenData(
            _effectiveRawTraits(tokenId, seed), _effectiveFusionMass(tokenId)
        );
    }

    function _effectiveRawTraits(uint256 tokenId, uint256 seed)
        internal
        view
        returns (INekoGenerator.RawTraits memory)
    {
        if (_hasMutatedTraits[tokenId]) {
            return _mutatedTraits[tokenId];
        }

        return generator.deriveRawTraits(seed);
    }

    function _effectiveFusionMass(uint256 tokenId) internal view returns (uint256) {
        uint256 storedMass = _fusionMassOverride[tokenId];
        return storedMass == 0 ? 1 : storedMass;
    }

    function _clearBurnedTokenState(uint256 tokenId) internal {
        delete _fusionMassOverride[tokenId];
        delete duplicateMergeCount[tokenId];
        delete mutationCount[tokenId];
        delete _hasMutatedTraits[tokenId];
        delete _mutatedTraits[tokenId];
    }

    function _combineLiveState(
        uint256 survivorTokenId,
        uint256 consumedTokenId,
        FusionAction action,
        uint16 mutationMask,
        uint256 survivorMass,
        uint256 consumedMass
    ) private returns (uint16 newRoot, uint256 newMass) {
        uint16 parentA = currentRoot(survivorTokenId);
        uint16 parentB = currentRoot(consumedTokenId);
        uint16 newDuplicateCount =
            duplicateMergeCount[survivorTokenId] + duplicateMergeCount[consumedTokenId];
        uint16 newMutationCount = mutationCount[survivorTokenId] + mutationCount[consumedTokenId];
        if (action == FusionAction.DuplicateMerge) {
            ++newDuplicateCount;
        } else {
            ++newMutationCount;
        }

        newRoot = nextNodeId;
        nextNodeId = newRoot + 1;
        ancestryNode[newRoot] = AncestryNode({
            parentA: parentA, parentB: parentB, action: action, mutationMask: mutationMask
        });
        ancestryRoot[survivorTokenId] = newRoot;

        newMass = survivorMass + consumedMass;
        _fusionMassOverride[survivorTokenId] = newMass;
        duplicateMergeCount[survivorTokenId] = newDuplicateCount;
        mutationCount[survivorTokenId] = newMutationCount;
    }

    function _requireAuthorization(address sender, uint256 tokenId, bool mutation) private view {
        address tokenOwner = ownerOf(tokenId);
        if (
            sender == tokenOwner || getApproved(tokenId) == sender
                || isApprovedForAll(tokenOwner, sender)
        ) {
            return;
        }
        if (mutation) {
            revert MutationCallerNotOwnerNorApproved(tokenId);
        }

        revert MergeCallerNotOwnerNorApproved(tokenId);
    }

    function _rawTraitsEqual(INekoGenerator.RawTraits memory a, INekoGenerator.RawTraits memory b)
        private
        pure
        returns (bool)
    {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    // ------------------------------------------------------------------
    // Deterministic profile-class permutation and quota-aware seed sampling
    // ------------------------------------------------------------------

    function _sampleTokenSeed(bytes32 seed, uint256 tokenId) internal view returns (uint256) {
        uint8 desiredClass = _desiredProfileClass(seed, tokenId);

        for (uint256 attempt; attempt < MAX_SEED_SAMPLING_ATTEMPTS; ++attempt) {
            bytes32 domain = attempt == 0 ? TOKEN_SEED_DOMAIN : SEED_RETRY_DOMAIN;
            uint256 candidate = uint256(keccak256(abi.encode(domain, seed, tokenId, attempt)));
            if (_profileMatches(candidate, desiredClass)) {
                return candidate;
            }
        }

        revert SeedSamplingExhausted(tokenId, desiredClass);
    }

    function _desiredProfileClass(bytes32 seed, uint256 tokenId) private pure returns (uint8) {
        uint256 position = _classPermutationPosition(seed, tokenId);
        if (position < PRIMARY_COLOR_QUOTA) {
            return BLACK_CLASS;
        }
        if (position < PRIMARY_COLOR_QUOTA * 2) {
            return WHITE_CLASS;
        }

        return NON_QUOTA_CLASS;
    }

    /// @dev Cycle-walking a keyed 13-bit Feistel permutation yields an exact permutation of 0..4662.
    function _classPermutationPosition(bytes32 seed, uint256 tokenId)
        private
        pure
        returns (uint256 position)
    {
        position = tokenId - 1;
        do {
            position = _permute13(seed, position);
        } while (position >= INTENDED_SUPPLY);
    }

    function _permute13(bytes32 seed, uint256 value) private pure returns (uint256) {
        uint256 left = value >> 7;
        uint256 right = value & 0x7f;
        for (uint256 round; round < 4; ++round) {
            left ^= uint256(keccak256(abi.encode(CLASS_PERMUTATION_DOMAIN, seed, round * 2, right)))
            & 0x3f;
            right ^= uint256(
                keccak256(abi.encode(CLASS_PERMUTATION_DOMAIN, seed, round * 2 + 1, left))
            ) & 0x7f;
        }

        return (left << 7) | right;
    }

    function _profileMatches(uint256 seed, uint8 desiredClass) private view returns (bool) {
        (bool matrix, bool invisible, uint8 bodyIndex) = generator.generationProfile(seed);

        if (matrix && bodyIndex == BLACK_BODY_INDEX) {
            return false;
        }
        if (invisible) {
            return desiredClass == NON_QUOTA_CLASS;
        }
        if (bodyIndex == BLACK_BODY_INDEX) {
            return desiredClass == BLACK_CLASS;
        }
        if (bodyIndex == WHITE_BODY_INDEX) {
            return desiredClass == WHITE_CLASS;
        }

        return desiredClass == NON_QUOTA_CLASS;
    }
}
