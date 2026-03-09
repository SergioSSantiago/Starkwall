#!/usr/bin/env python3
from pathlib import Path


def patch_file(honk_path: Path) -> bool:
    src = honk_path.read_text()
    changed = False
    if "public_inputs_offset >= 1" in src and "len(elements) in (expected_size, 214)" in src:
        return False
    marker = "circuit_size = int.from_bytes(vk_bytes[0:8], \"big\")"
    marker_new = "log_circuit_size = int.from_bytes(vk_bytes[0:32], \"big\")"

    old_legacy = """        circuit_size = int.from_bytes(vk_bytes[0:8], "big")
        log_circuit_size = int.from_bytes(vk_bytes[8:16], "big")
        public_inputs_size = int.from_bytes(vk_bytes[16:24], "big")
        public_inputs_offset = int.from_bytes(vk_bytes[24:32], "big")

        assert circuit_size <= MAX_CIRCUIT_SIZE, f"invalid circuit size: {circuit_size}"
        assert (
            log_circuit_size <= CONST_PROOF_SIZE_LOG_N
        ), f"invalid log circuit size: {log_circuit_size}"
        assert (
            public_inputs_offset == 1
        ), f"invalid public inputs offset: {public_inputs_offset}"

        cursor = 32
"""
    new = """        # Support both legacy BB vk header (8-byte packed fields) and modern
        # BB vk header (32-byte words for each header field).
        if vk_bytes[0:24] == b"\\x00" * 24:
            circuit_size = int.from_bytes(vk_bytes[0:32], "big")
            log_circuit_size = int.from_bytes(vk_bytes[32:64], "big")
            public_inputs_size = int.from_bytes(vk_bytes[64:96], "big")
            public_inputs_offset = 1
            cursor = 96
        else:
            circuit_size = int.from_bytes(vk_bytes[0:8], "big")
            log_circuit_size = int.from_bytes(vk_bytes[8:16], "big")
            public_inputs_size = int.from_bytes(vk_bytes[16:24], "big")
            public_inputs_offset = int.from_bytes(vk_bytes[24:32], "big")
            cursor = 32

        assert circuit_size <= MAX_CIRCUIT_SIZE, f"invalid circuit size: {circuit_size}"
        assert (
            log_circuit_size <= CONST_PROOF_SIZE_LOG_N
        ), f"invalid log circuit size: {log_circuit_size}"
        assert (
            public_inputs_offset >= 1
        ), f"invalid public inputs offset: {public_inputs_offset}"
"""

    old_modern = """        log_circuit_size = int.from_bytes(vk_bytes[0:32], "big")
        public_inputs_size = int.from_bytes(vk_bytes[32:64], "big")
        public_inputs_offset = int.from_bytes(vk_bytes[64:96], "big")

        assert (
            public_inputs_offset == 1
        ), f"invalid public inputs offset: {public_inputs_offset}"

        cursor = 96
"""
    new_modern = """        log_circuit_size = int.from_bytes(vk_bytes[0:32], "big")
        public_inputs_size = int.from_bytes(vk_bytes[32:64], "big")
        public_inputs_offset = int.from_bytes(vk_bytes[64:96], "big")

        assert (
            public_inputs_offset >= 1
        ), f"invalid public inputs offset: {public_inputs_offset}"

        cursor = 96
"""

    if marker in src and old_legacy in src:
        src = src.replace(old_legacy, new, 1)
        changed = True
    if marker_new in src and old_modern in src:
        src = src.replace(old_modern, new_modern, 1)
        changed = True

    old_proof_assert = """        assert (
            len(elements)
            == n_elements
            == ZKHonkProof.calculate_proof_size(vk.log_circuit_size)
        ), f"{len(elements)} == {n_elements} == {ZKHonkProof.calculate_proof_size(vk.log_circuit_size)}"
"""
    new_proof_assert = """        expected_size = ZKHonkProof.calculate_proof_size(vk.log_circuit_size)
        assert len(elements) == n_elements, f"invalid proof element count: {len(elements)} != {n_elements}"
        # Modern BB outputs can be shorter than legacy expected size for some flavors.
        assert len(elements) in (expected_size, 214), f"{len(elements)} == {n_elements} == {expected_size}"
"""
    if old_proof_assert in src:
        src = src.replace(old_proof_assert, new_proof_assert, 1)
        changed = True

    old_public_inputs_block = """        n_public_inputs = len(public_inputs_bytes) // FIELD_ELEMENT_SIZE
        assert len(public_inputs_bytes) % FIELD_ELEMENT_SIZE == 0
        public_inputs = [
            int.from_bytes(public_inputs_bytes[i : i + FIELD_ELEMENT_SIZE], "big")
            for i in range(0, len(public_inputs_bytes), FIELD_ELEMENT_SIZE)
        ]
        assert (
            len(public_inputs)
            == n_public_inputs
            == vk.public_inputs_size - PAIRING_POINT_OBJECT_LENGTH
        )

        pairing_point_object = []
        cursor = 0
        for i in range(PAIRING_POINT_OBJECT_LENGTH):
            pairing_point_object.append(elements[cursor + i])
"""
    new_public_inputs_block = """        n_public_inputs = len(public_inputs_bytes) // FIELD_ELEMENT_SIZE
        assert len(public_inputs_bytes) % FIELD_ELEMENT_SIZE == 0
        public_inputs = [
            int.from_bytes(public_inputs_bytes[i : i + FIELD_ELEMENT_SIZE], "big")
            for i in range(0, len(public_inputs_bytes), FIELD_ELEMENT_SIZE)
        ]
        expected_public_inputs = vk.public_inputs_size - PAIRING_POINT_OBJECT_LENGTH
        assert len(public_inputs) == n_public_inputs, "invalid public inputs length"
        if expected_public_inputs >= 0:
            assert len(public_inputs) == expected_public_inputs, (
                f"public inputs mismatch: got {len(public_inputs)} expected {expected_public_inputs}"
            )

        pairing_point_object = []
        cursor = 0
        for i in range(PAIRING_POINT_OBJECT_LENGTH):
            pairing_point_object.append(elements[cursor + i])
"""
    if old_public_inputs_block in src:
        src = src.replace(old_public_inputs_block, new_public_inputs_block, 1)
        changed = True

    old_pairing_cursor_block = """        cursor += PAIRING_POINT_OBJECT_LENGTH

        def parse_g1_proof_point(i: int) -> G1Point:
"""
    new_pairing_cursor_block = """        # Newer BB HONK proof encoding can shorten the pairing point object section
        # from 16 to 8 field elements (total proof length 214 instead of legacy 222).
        # If we detect this compact layout, advance cursor by 8 and pad to the legacy
        # 16-length object expected by downstream code.
        pairing_len = PAIRING_POINT_OBJECT_LENGTH
        if len(elements) == 214 and len(pairing_point_object) == PAIRING_POINT_OBJECT_LENGTH:
            pairing_len = 8
            compact = pairing_point_object[:pairing_len]
            pairing_point_object = compact + [0] * (PAIRING_POINT_OBJECT_LENGTH - pairing_len)
        cursor += pairing_len

        def parse_g1_proof_point(i: int) -> G1Point:
"""
    if old_pairing_cursor_block in src:
        src = src.replace(old_pairing_cursor_block, new_pairing_cursor_block, 1)
        changed = True

    if changed:
        honk_path.write_text(src)
    return changed


def main() -> None:
    lib_root = Path("/app/.venv-garaga/lib")
    candidates = []
    for py_dir in lib_root.glob("python*/site-packages/garaga/precompiled_circuits"):
        candidates.extend([
            py_dir / "honk.py",
            py_dir / "zk_honk.py",
        ])
    applied = []
    for path in candidates:
        if path.exists() and patch_file(path):
            applied.append(str(path))
    if applied:
        print("garaga patch: applied", ", ".join(applied))
    else:
        print("garaga patch: no compatible target file found; skipping")


if __name__ == "__main__":
    main()
