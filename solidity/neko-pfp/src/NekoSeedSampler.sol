// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {NekoRenderer} from "./NekoRenderer.sol";

/// @notice Deterministic profile-class permutation and quota-aware token-seed sampling.
///         A keyed 13-bit Feistel permutation assigns each token a color class, and
///         rejection sampling finds the first candidate seed whose profile matches it.
abstract contract NekoSeedSampler {
    error SeedSamplingExhausted(uint256 tokenId, uint8 desiredClass);

    uint256 public constant MAX_SUPPLY = 4663;
    uint256 public constant PRIMARY_COLOR_QUOTA = 96;

    uint256 private constant MAX_SEED_SAMPLING_ATTEMPTS = 512;
    uint8 private constant NON_QUOTA_CLASS = 0;
    uint8 private constant BLACK_CLASS = 1;
    uint8 private constant WHITE_CLASS = 2;
    uint8 private constant BLACK_BODY_INDEX = 16;
    uint8 private constant WHITE_BODY_INDEX = 17;
    bytes32 private constant CLASS_PERMUTATION_DOMAIN =
        keccak256("NekoPFPSeaDrop.classPermutation.v1");
    bytes32 private constant TOKEN_SEED_DOMAIN = keccak256("NekoPFPSeaDrop.tokenSeed.v1");
    bytes32 private constant SEED_RETRY_DOMAIN = keccak256("NekoPFPSeaDrop.seedRetry.v1");

    function _sampleTokenSeed(NekoRenderer renderer, bytes32 seed, uint256 tokenId)
        internal
        pure
        returns (uint256)
    {
        uint8 desiredClass = _desiredProfileClass(seed, tokenId);

        for (uint256 attempt; attempt < MAX_SEED_SAMPLING_ATTEMPTS; ++attempt) {
            bytes32 domain = attempt == 0 ? TOKEN_SEED_DOMAIN : SEED_RETRY_DOMAIN;
            uint256 candidate = uint256(keccak256(abi.encode(domain, seed, tokenId, attempt)));
            if (_profileMatches(renderer, candidate, desiredClass)) {
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
        } while (position >= MAX_SUPPLY);
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

    function _profileMatches(NekoRenderer renderer, uint256 seed, uint8 desiredClass)
        private
        pure
        returns (bool)
    {
        (bool matrix, bool invisible, uint8 bodyIndex) = renderer.profile(seed);

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
