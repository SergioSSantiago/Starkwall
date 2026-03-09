#!/usr/bin/env python3
from pathlib import Path


def replace_once(src: str, old: str, new: str, label: str) -> tuple[str, bool]:
    if old not in src:
        return src, False
    return src.replace(old, new, 1), True


def patch_flavor_concepts(base: Path) -> None:
    p = base / "barretenberg/cpp/src/barretenberg/flavor/flavor_concepts.hpp"
    src = p.read_text()
    marker = "namespace bb {\n"
    if marker not in src:
        raise RuntimeError("patch target not found: flavor_concepts namespace")
    if "class UltraStarknetZKFlavor;" not in src:
        insert = (
            "namespace bb {\n"
            "#ifdef STARKNET_GARAGA_FLAVORS\n"
            "class UltraStarknetFlavor;\n"
            "class UltraStarknetZKFlavor;\n"
            "#endif\n"
        )
        src = src.replace(marker, insert, 1)
    p.write_text(src)


def patch_poseidon_permutation(base: Path) -> None:
    p = base / "barretenberg/cpp/src/barretenberg/ext/starknet/crypto/poseidon/poseidon_permutation.hpp"
    src = p.read_text()
    if "static constexpr void permutation_inplace(State& state)" not in src:
        src, ok = replace_once(
            src,
            "    static constexpr State permutation(const State& input)\n    {\n",
            "    static constexpr void permutation_inplace(State& state)\n"
            "    {\n"
            "        state = permutation(state);\n"
            "    }\n\n"
            "    static constexpr State permutation(const State& input)\n"
            "    {\n",
            "poseidon permutation_inplace",
        )
        if not ok:
            raise RuntimeError("patch target not found: poseidon permutation_inplace")
    p.write_text(src)


def patch_starknet_transcript(base: Path) -> None:
    p = base / "barretenberg/cpp/src/barretenberg/ext/starknet/transcript/transcript.hpp"
    src = p.read_text()
    if "BaseTranscript<bb::FrCodec, StarknetTranscriptHash>" not in src:
        src, ok = replace_once(
            src,
            "struct StarknetTranscriptParams : public bb::KeccakTranscriptParams {\n"
            "    static inline Fr hash(const std::vector<Fr>& data) { return starknet_hash_uint256(data); }\n"
            "};\n\n"
            "using StarknetTranscript = bb::BaseTranscript<StarknetTranscriptParams>;\n",
            "struct StarknetTranscriptHash {\n"
            "    using Fr = bb::fr;\n"
            "    static inline Fr hash(const std::vector<Fr>& data) { return starknet_hash_uint256(data); }\n"
            "};\n\n"
            "using StarknetTranscript = bb::BaseTranscript<bb::FrCodec, StarknetTranscriptHash>;\n",
            "starknet transcript api",
        )
        if not ok:
            raise RuntimeError("patch target not found: starknet transcript api")
    p.write_text(src)


def patch_starknet_flavor(base: Path) -> None:
    p = base / "barretenberg/cpp/src/barretenberg/ext/starknet/flavor/ultra_starknet_flavor.hpp"
    src = p.read_text()
    if "using Transcript = starknet::StarknetTranscript;" not in src:
        src, ok = replace_once(
            src,
            "    using Transcript = Transcript_<starknet::StarknetTranscriptParams>;\n",
            "    using Transcript = starknet::StarknetTranscript;\n",
            "starknet flavor transcript alias",
        )
        if not ok:
            raise RuntimeError("patch target not found: starknet flavor transcript alias")
    p.write_text(src)


def patch_flavor_shims(base: Path) -> None:
    flavor_dir = base / "barretenberg/cpp/src/barretenberg/flavor"
    shim = flavor_dir / "ultra_starknet_flavor.hpp"
    if not shim.exists():
        shim.write_text(
            '#pragma once\n'
            '#ifdef STARKNET_GARAGA_FLAVORS\n'
            '#include "barretenberg/ext/starknet/flavor/ultra_starknet_flavor.hpp"\n'
            '#endif\n'
        )
    shim_zk = flavor_dir / "ultra_starknet_zk_flavor.hpp"
    if not shim_zk.exists():
        shim_zk.write_text(
            '#pragma once\n'
            '#ifdef STARKNET_GARAGA_FLAVORS\n'
            '#include "barretenberg/ext/starknet/flavor/ultra_starknet_zk_flavor.hpp"\n'
            '#endif\n'
        )


def main() -> None:
    base = Path("/tmp/aztec-packages")
    patch_flavor_concepts(base)
    patch_poseidon_permutation(base)
    patch_starknet_transcript(base)
    patch_starknet_flavor(base)
    patch_flavor_shims(base)
    print("bb v4.0.4 starknet patch: applied")


if __name__ == "__main__":
    main()
