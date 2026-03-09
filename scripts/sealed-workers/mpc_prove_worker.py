#!/usr/bin/env python3
"""
MPC proof adapter for Starkwall sealed relayer.

Input:
  STARKWALL_JOB_JSON

Output:
  {
    "proofCalldata": ["123", "456", ...],
    "proofCalldataHash": "0x...",      # optional
    "witnessHash": "0x...",            # optional
    "proofHash": "0x...",              # optional
    "vkHash": "0x...",                 # optional
    "publicInputsHash": "0x..."        # optional
  }

Modes:
  1) Real adapter: STARKWALL_MPC_PROVE_URL
  2) Mock adapter: STARKWALL_MPC_ALLOW_MOCK=1
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def load_job() -> dict:
    raw = os.getenv("STARKWALL_JOB_JSON", "").strip()
    if not raw:
        fail("Missing STARKWALL_JOB_JSON")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Invalid STARKWALL_JOB_JSON: {exc}")
    if not isinstance(data, dict):
        fail("STARKWALL_JOB_JSON must decode to object")
    return data


def post_json(url: str, payload: dict, timeout_s: int = 30) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        fail(f"MPC prove adapter HTTP {exc.code}: {detail}")
    except Exception as exc:  # pragma: no cover
        fail(f"MPC prove adapter request failed: {exc}")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"MPC prove adapter returned invalid JSON: {exc}")
    if not isinstance(parsed, dict):
        fail("MPC prove adapter response must be object")
    return parsed


def mock_proof(job: dict) -> dict:
    seed = json.dumps(job, sort_keys=True, separators=(",", ":")).encode("utf-8")
    h = hashlib.sha256(seed).hexdigest()
    c1 = int(h[:16], 16)
    c2 = int(h[16:32], 16)
    c3 = int(h[32:48], 16)
    c4 = int(h[48:64], 16)
    proof_calldata = [str(c1), str(c2), str(c3), str(c4)]
    return {
        "proofCalldata": proof_calldata,
        "proofCalldataHash": f"0x{hashlib.sha256(','.join(proof_calldata).encode('utf-8')).hexdigest()}",
        "witnessHash": f"0x{hashlib.sha256(seed + b':w').hexdigest()}",
        "proofHash": f"0x{hashlib.sha256(seed + b':p').hexdigest()}",
        "vkHash": f"0x{hashlib.sha256(seed + b':vk').hexdigest()}",
        "publicInputsHash": f"0x{hashlib.sha256(seed + b':pi').hexdigest()}",
    }


def validate_proof_response(result: dict) -> dict:
    values = result.get("proofCalldata", [])
    if not isinstance(values, list) or not values:
        fail("MPC prove adapter returned empty proofCalldata")
    normalized = []
    for token in values:
        text = str(token).strip()
        if not text:
            fail("MPC prove adapter returned invalid proofCalldata token")
        if text.startswith("0x"):
            int(text, 16)
        else:
            int(text)
        normalized.append(text)
    output = {"proofCalldata": normalized}
    for key in ("proofCalldataHash", "witnessHash", "proofHash", "vkHash", "publicInputsHash"):
        value = str(result.get(key, "")).strip()
        if value:
            if not value.startswith("0x"):
                fail(f"{key} must be hex felt")
            output[key] = value
    return output


def main() -> None:
    job = load_job()
    adapter_url = os.getenv("STARKWALL_MPC_PROVE_URL", "").strip()
    allow_mock = os.getenv("STARKWALL_MPC_ALLOW_MOCK", "0").strip() == "1"

    if adapter_url:
        result = post_json(adapter_url, job)
    elif allow_mock:
        result = mock_proof(job)
    else:
        fail(
            "MPC prove adapter not configured. Set STARKWALL_MPC_PROVE_URL "
            "or STARKWALL_MPC_ALLOW_MOCK=1."
        )

    print(json.dumps(validate_proof_response(result)))


if __name__ == "__main__":
    main()

