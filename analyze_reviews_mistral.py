#!/usr/bin/env python3
"""Generate semantic review insights with Mistral and store them in Supabase."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

import requests


DEFAULT_MODEL = os.environ.get("MISTRAL_MODEL", "mistral-small-latest")
DEFAULT_REVIEW_PROMPT = (
    "Group Capterra reviews into coherent business themes. Return clean keywords, top pros, top cons, "
    "and categorized performance with an overall synthesis. Avoid malformed words, raw stop words, "
    "generic brand-only terms, and vague labels."
)
REVIEWS_TABLE = os.environ.get("SUPABASE_TABLE", "capterra_reviews")
INSIGHTS_TABLE = os.environ.get("SUPABASE_INSIGHTS_TABLE", "capterra_review_insights")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Variable d'environnement manquante: {name}")
    return value


def supabase_headers(key: str) -> dict[str, str]:
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def fetch_reviews(supabase_url: str, supabase_key: str, product_slug: str, limit: int) -> list[dict[str, Any]]:
    url = f"{supabase_url.rstrip('/')}/rest/v1/{REVIEWS_TABLE}"
    params = {
        "select": "review_date_iso,review_date,reviewer,title,rating,data",
        "product_slug": f"eq.{product_slug}",
        "order": "review_date_iso.desc.nullslast,created_at.desc",
        "limit": str(limit),
    }
    response = requests.get(url, headers=supabase_headers(supabase_key), params=params, timeout=60)
    if response.status_code >= 400:
        raise RuntimeError(f"Erreur Supabase lecture {response.status_code}: {response.text[:1000]}")
    return response.json()


def compact_review(review: dict[str, Any]) -> dict[str, Any]:
    data = review.get("data") or {}
    return {
        "date": review.get("review_date_iso") or review.get("review_date"),
        "rating": review.get("rating"),
        "title": review.get("title"),
        "summary": data.get("summary"),
        "pros": data.get("pros"),
        "cons": data.get("cons"),
        "role": data.get("reviewer_role"),
        "industry": data.get("reviewer_industry"),
    }


def build_prompt(product_slug: str, reviews: list[dict[str, Any]], review_prompt: str) -> list[dict[str, str]]:
    payload = [compact_review(review) for review in reviews]
    schema = {
        "keywords": [{"theme": "Clear semantic keyword, no typo", "count": 12}],
        "top_pros": [{"title": "Theme name", "description": "Concrete takeaway from reviews", "count": 12, "example": "Short paraphrased example"}],
        "top_cons": [{"title": "Theme name", "description": "Concrete takeaway from reviews", "count": 8, "example": "Short paraphrased example"}],
        "categories": [{"category": "Overall Experience", "score": 4.4, "trend": "High", "takeaway": "Strategic synthesis"}],
    }
    system = (
        "You analyze SaaS product reviews. Return only valid JSON. "
        "Group related wording into coherent semantic themes. "
        "Do not output raw malformed tokens, misspellings, stop words, brand-only words, or generic words. "
        "Prefer business labels such as Ease of use, Virtual cards, Expense workflows, Pricing concerns. "
        "Scores must be numeric between 0 and 5."
    )
    user = {
        "task": f"Create coherent analytics insights for Capterra reviews of {product_slug}.",
        "analysis_instructions": review_prompt,
        "output_schema": schema,
        "required_categories": ["Overall Experience", "Features", "Pricing", "Ease of Use"],
        "reviews": payload,
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


def call_mistral(api_key: str, model: str, messages: list[dict[str, str]]) -> dict[str, Any]:
    response = requests.post(
        "https://api.mistral.ai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": model, "messages": messages, "temperature": 0.2, "response_format": {"type": "json_object"}},
        timeout=120,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Erreur Mistral {response.status_code}: {response.text[:1000]}")
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)


def save_insights(
    supabase_url: str,
    supabase_key: str,
    product_slug: str,
    model: str,
    insights: dict[str, Any],
) -> None:
    url = f"{supabase_url.rstrip('/')}/rest/v1/{INSIGHTS_TABLE}"
    row = {
        "product_slug": product_slug,
        "model": model,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "insights": insights,
    }
    response = requests.post(
        url,
        headers={**supabase_headers(supabase_key), "Prefer": "resolution=merge-duplicates"},
        params={"on_conflict": "product_slug"},
        json=[row],
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Erreur Supabase ecriture {response.status_code}: {response.text[:1000]}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Mistral semantic insights for Capterra reviews.")
    parser.add_argument("--product-slug", default="spendesk")
    parser.add_argument("--limit", type=int, default=240, help="Nombre de reviews envoyees a Mistral.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--prompt", default=os.environ.get("MISTRAL_REVIEW_PROMPT", DEFAULT_REVIEW_PROMPT))
    args = parser.parse_args()

    supabase_url = require_env("SUPABASE_URL")
    supabase_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    mistral_key = require_env("MISTRAL_API_KEY")

    reviews = fetch_reviews(supabase_url, supabase_key, args.product_slug, args.limit)
    if not reviews:
        raise RuntimeError("Aucune review trouvee dans Supabase.")

    insights = call_mistral(mistral_key, args.model, build_prompt(args.product_slug, reviews, args.prompt))
    save_insights(supabase_url, supabase_key, args.product_slug, args.model, insights)
    print(f"Insights IA sauvegardes pour {args.product_slug}: {len(reviews)} reviews analysees.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Erreur: {exc}", file=sys.stderr)
        raise
