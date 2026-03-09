#!/usr/bin/env python3
"""
Timelock decrypt adapter for Starkwall sealed relayer.

Input:
  STARKWALL_JOB_JSON (env) - JSON payload from relayer

Output (stdout JSON):
  { "bidAmount": <int>, "salt": "0x..." }

Modes:
  1) Real adapter: set STARKWALL_TIMELOCK_DECRYPT_URL (POST JSON -> JSON response)
  2) Mock adapter: set STARKWALL_TIMELOCK_ALLOW_MOCK=1 for local smoke tests
"""

from __future__ import annotations

import hashlib
import base64
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
        job = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Invalid STARKWALL_JOB_JSON: {exc}")
    if not isinstance(job, dict):
        fail("STARKWALL_JOB_JSON must decode to object")
    return job


def post_json(url: str, payload: dict, timeout_s: int = 20) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        fail(f"Decrypt adapter HTTP {exc.code}: {detail}")
    except Exception as exc:  # pragma: no cover
        fail(f"Decrypt adapter request failed: {exc}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Decrypt adapter returned invalid JSON: {exc}")
    if not isinstance(data, dict):
        fail("Decrypt adapter response must be object")
    return data


def derive_mock_payload(job: dict) -> dict:
    inline_payload = str(job.get("timelockPayload", "")).strip()
    if inline_payload:
        try:
            decoded = base64.b64decode(inline_payload.encode("utf-8")).decode("utf-8")
            parsed = json.loads(decoded)
            bid_amount = int(parsed.get("bidAmount", 0))
            salt = str(parsed.get("salt", "")).strip()
            if bid_amount > 0 and salt.startswith("0x"):
                return {"bidAmount": bid_amount, "salt": salt}
        except Exception:
            pass
    source = "|".join(
        [
            str(job.get("id", "")),
            str(job.get("slotPostId", "")),
            str(job.get("groupId", "")),
            str(job.get("bidder", "")),
            str(job.get("drandRound", "")),
            str(job.get("timelockCiphertextHash", "")),
        ]
    )
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    mock_bid = int(os.getenv("STARKWALL_TIMELOCK_MOCK_BID", "5"))
    if mock_bid <= 0:
        mock_bid = 5
    return {
        "bidAmount": mock_bid,
        "salt": f"0x{digest}",
    }


def parse_inline_payload(job: dict) -> dict | None:
    inline_payload = str(job.get("timelockPayload", "")).strip()
    if not inline_payload:
        return None
    try:
        decoded = base64.b64decode(inline_payload.encode("utf-8")).decode("utf-8")
        parsed = json.loads(decoded)
    except Exception:
        return None
    bid_amount = int(parsed.get("bidAmount", 0))
    salt = str(parsed.get("salt", "")).strip()
    if bid_amount <= 0 or not salt.startswith("0x"):
        return None
    return {"bidAmount": bid_amount, "salt": salt}


def main() -> None:
    job = load_job()
    adapter_url = os.getenv("STARKWALL_TIMELOCK_DECRYPT_URL", "").strip()
    allow_mock = os.getenv("STARKWALL_TIMELOCK_ALLOW_MOCK", "0").strip() == "1"
    inline = parse_inline_payload(job)
    if inline is not None:
        result = inline
    elif adapter_url:
        result = post_json(adapter_url, job)
    elif allow_mock:
        result = derive_mock_payload(job)
    else:
        fail(
            "Timelock decrypt adapter not configured. Set STARKWALL_TIMELOCK_DECRYPT_URL "
            "or STARKWALL_TIMELOCK_ALLOW_MOCK=1."
        )

    bid_amount = int(result.get("bidAmount", 0))
    salt = str(result.get("salt", "")).strip()
    if bid_amount <= 0:
        fail("Decrypt adapter returned invalid bidAmount")
    if not salt or not salt.startswith("0x"):
        fail("Decrypt adapter returned invalid salt")

    print(json.dumps({"bidAmount": bid_amount, "salt": salt}))


if __name__ == "__main__":
    main()

