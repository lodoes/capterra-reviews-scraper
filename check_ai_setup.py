#!/usr/bin/env python3
"""Check Mistral + Supabase AI setup without exposing secrets."""

from __future__ import annotations

import argparse
import os
import sys

import requests

from analyze_reviews_mistral import (
    DEFAULT_MODEL,
    INSIGHTS_TABLE,
    REVIEWS_TABLE,
    fetch_reviews,
    require_env,
    save_insights,
    supabase_headers,
    test_mistral,
)


def ok(label: str, detail: str = "") -> None:
    print(f"[OK] {label}{': ' + detail if detail else ''}")


def fail(label: str, detail: str) -> None:
    print(f"[FAIL] {label}: {detail}")


def check_table(supabase_url: str, supabase_key: str, table: str) -> bool:
    url = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    response = requests.get(
        url,
        headers=supabase_headers(supabase_key),
        params={"select": "*", "limit": "1"},
        timeout=30,
    )
    if response.status_code >= 400:
        fail(table, f"{response.status_code} {response.text[:500]}")
        return False
    ok(table, "readable")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the AI analytics setup.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--product-slug", default="spendesk")
    parser.add_argument("--write-test", action="store_true", help="Write a tiny diagnostic insight row to Supabase.")
    args = parser.parse_args()

    passed = True

    try:
        mistral_key = require_env("MISTRAL_API_KEY")
        ok("MISTRAL_API_KEY", "present")
    except Exception as exc:
        fail("MISTRAL_API_KEY", str(exc))
        return 1

    try:
        result = test_mistral(mistral_key, args.model)
        ok("Mistral connection", f"{args.model} -> {result}")
    except Exception as exc:
        fail("Mistral connection", str(exc))
        passed = False

    try:
        supabase_url = require_env("SUPABASE_URL")
        supabase_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
        ok("Supabase env", supabase_url)
    except Exception as exc:
        fail("Supabase env", str(exc))
        return 1 if not passed else 2

    passed = check_table(supabase_url, supabase_key, REVIEWS_TABLE) and passed
    passed = check_table(supabase_url, supabase_key, INSIGHTS_TABLE) and passed

    try:
        reviews = fetch_reviews(supabase_url, supabase_key, args.product_slug, 5)
        ok("Review fetch", f"{len(reviews)} review(s) loaded for {args.product_slug}")
    except Exception as exc:
        fail("Review fetch", str(exc))
        passed = False

    if args.write_test:
        try:
            save_insights(
                supabase_url,
                supabase_key,
                args.product_slug,
                args.model,
                {
                    "keywords": [{"theme": "AI setup diagnostic", "count": 1}],
                    "top_pros": [],
                    "top_cons": [],
                    "categories": [{
                        "category": "Overall Experience",
                        "score": 0,
                        "trend": "Diagnostic",
                        "takeaway": "AI setup write test completed.",
                    }],
                },
            )
            ok("Insight write", f"diagnostic row upserted in {INSIGHTS_TABLE}")
        except Exception as exc:
            fail("Insight write", str(exc))
            passed = False

    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
