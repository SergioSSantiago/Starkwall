#!/usr/bin/env python3
"""
MPC attestation adapter for Starkwall sealed relayer.

Input:
  STARKWALL_JOB_JSON

Output:
  {
    "mpcTranscriptHash": "0x...",
    "mpcAttestationRoot": "0x...",
    "mpcSignerBitmapHash": "0x..."
  }

Modes:
  1) Real adapter: STARKWALL_MPC_ATTEST_URL
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
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Invalid STARKWALL_JOB_JSON: {exc}")
    if not isinstance(value, dict):
        fail("STARKWALL_JOB_JSON must decode to object")
    return value


def post_json(url: str, payload: dict, timeout_s: int = 20) -> dict:
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
        fail(f"MPC attestation adapter HTTP {exc.code}: {detail}")
    except Exception as exc:  # pragma: no cover
        fail(f"MPC attestation adapter request failed: {exc}")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"MPC attestation adapter returned invalid JSON: {exc}")
    if not isinstance(parsed, dict):
        fail("MPC attestation adapter response must be object")
    return parsed


def mock_attestation(job: dict) -> dict:
    seed = json.dumps(job, sort_keys=True, separators=(",", ":")).encode("utf-8")
    h1 = hashlib.sha256(seed + b":transcript").hexdigest()
    h2 = hashlib.sha256(seed + b":root").hexdigest()
    h3 = hashlib.sha256(seed + b":bitmap").hexdigest()
    return {
        "mpcTranscriptHash": f"0x{h1}",
        "mpcAttestationRoot": f"0x{h2}",
        "mpcSignerBitmapHash": f"0x{h3}",
    }


def main() -> None:
    job = load_job()
    adapter_url = os.getenv("STARKWALL_MPC_ATTEST_URL", "").strip()
    allow_mock = os.getenv("STARKWALL_MPC_ALLOW_MOCK", "0").strip() == "1"

    if adapter_url:
        result = post_json(adapter_url, job)
    elif allow_mock:
        result = mock_attestation(job)
    else:
        fail(
            "MPC attestation adapter not configured. Set STARKWALL_MPC_ATTEST_URL "
            "or STARKWALL_MPC_ALLOW_MOCK=1."
        )

    transcript = str(result.get("mpcTranscriptHash", "")).strip()
    root = str(result.get("mpcAttestationRoot", "")).strip()
    bitmap = str(result.get("mpcSignerBitmapHash", "")).strip()
    if not transcript.startswith("0x"):
        fail("Invalid mpcTranscriptHash")
    if not root.startswith("0x"):
        fail("Invalid mpcAttestationRoot")
    if not bitmap.startswith("0x"):
        fail("Invalid mpcSignerBitmapHash")

    print(
        json.dumps(
            {
                "mpcTranscriptHash": transcript,
                "mpcAttestationRoot": root,
                "mpcSignerBitmapHash": bitmap,
            }
        )
    )


if __name__ == "__main__":
    main()

