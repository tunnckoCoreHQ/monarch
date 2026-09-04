// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

/// @notice Canonical raw-trait resolution and presentation for Neko PFP tokens.
interface INekoGenerator {
    struct RawTraits {
        uint8 sky;
        uint8 head;
        uint8 face;
        uint8 body;
        uint8 tail;
        uint8[4] legs;
        uint8[2] eyes;
        uint8 mouth;
        uint8 toy;
        uint8 alternateLegMask;
        uint8 alternateEyeMask;
        bool alternateHead;
        bool alternateMouth;
        bool alternateTail;
        bool invisible;
        bool matrix;
    }

    struct TokenData {
        RawTraits traits;
        uint8 slopTier;
        uint256 fusionMass;
    }

    function deriveRawTraits(uint256 seed) external view returns (RawTraits memory);

    function resolveTokenData(RawTraits calldata traits, uint256 fusionMass)
        external
        view
        returns (TokenData memory);

    function combineRawTraits(
        RawTraits calldata survivor,
        RawTraits calldata consumed,
        uint16 consumedPartsMask
    ) external view returns (RawTraits memory);

    function generateSVG(uint256 seed, TokenData calldata data)
        external
        view
        returns (string memory);

    function generateImageURI(uint256 seed, TokenData calldata data)
        external
        view
        returns (string memory uri, bytes32 contentHash);

    function generateUnrevealedImageURI() external view returns (string memory);

    function generateUnrevealedTokenURI(uint256 tokenId) external view returns (string memory);

    function generateTokenURI(uint256 seed, uint256 tokenId, TokenData calldata data)
        external
        view
        returns (string memory);

    function generationProfile(uint256 seed)
        external
        view
        returns (bool matrix, bool invisible, uint8 bodyIndex);

    function catSignature(RawTraits calldata traits) external view returns (bytes32);
}
