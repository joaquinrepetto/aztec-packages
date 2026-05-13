#pragma once
#include "barretenberg/ecc/curves/grumpkin/grumpkin.hpp"
#include <array>
#include <cstddef>
#include <cstdint>

namespace bb::srs {

/**
 * @brief Canonical number of points in the Aztec Grumpkin SRS published at
 * `https://crs.aztec-cdn.foundation/grumpkin_g1.dat`.
 *
 * @details Sized for ECCVM proving (`CONST_ECCVM_LOG_N = 15`, 2^15 IPA opening rounds) with one
 * doubling of headroom. This is the size that `barretenberg/crs/bootstrap.sh` downloads and that
 * `GRUMPKIN_G1_SHA256` covers.
 */
inline constexpr size_t GRUMPKIN_G1_NUM_POINTS = 1ULL << 18;

/**
 * @brief Canonical byte length of the Aztec Grumpkin SRS file.
 *
 * @details Each affine point is 64 bytes (Fq.x ‖ Fq.y, big-endian). 2^18 × 64 = 16 MiB.
 */
inline constexpr size_t GRUMPKIN_G1_SIZE_BYTES = GRUMPKIN_G1_NUM_POINTS * sizeof(curve::Grumpkin::AffineElement);

/**
 * @brief SHA-256 hash of the canonical Aztec Grumpkin SRS bytes — the first
 * `GRUMPKIN_G1_SIZE_BYTES` bytes of `https://crs.aztec-cdn.foundation/grumpkin_g1.dat`, equivalently
 * the SHA-256 of `to_buffer(generate_grumpkin_srs(GRUMPKIN_G1_NUM_POINTS))`.
 *
 * @details The Grumpkin SRS does not require a trusted setup; correctness comes from a fixed seed
 * (`"BARRETENBERG_GRUMPKIN_IPA_CRS"`) plus deterministic hash-to-curve. Two CI tests in
 * `crs_factory.test.cpp` pin this constant:
 *   - `GrumpkinG1OnDiskMatchesPinnedHash` — gates that `barretenberg/crs/bootstrap.sh` produced
 *     the canonical file.
 *   - `GrumpkinG1GeneratorMatchesPinnedHash` — gates that the generator's output still hashes to
 *     this constant (i.e. the seed-derived SRS hasn't drifted, e.g. via a curve-deserialization
 *     change).
 *
 * Update this constant only in lockstep with re-uploading the file to both CRS hosts.
 */
inline constexpr std::array<uint8_t, 32> GRUMPKIN_G1_SHA256 = { 0x87, 0xfe, 0x78, 0x28, 0x60, 0xdd, 0x58, 0xf0,
                                                                0x9a, 0x81, 0xf7, 0x97, 0xb5, 0x63, 0x46, 0x39,
                                                                0x8a, 0xab, 0xe6, 0xe0, 0xed, 0x98, 0xe0, 0xa5,
                                                                0xcc, 0xf1, 0x46, 0x04, 0xdd, 0x8b, 0xae, 0xe2 };

} // namespace bb::srs
