#!/usr/bin/env python3
"""
Scraper d'avis Capterra -> CSV + JSON, avec SeleniumBase (mode UC undetected).

SeleniumBase pilote un vrai Chrome "indetectable" qui passe la protection
Cloudflare de Capterra. Une fenetre Chrome s'ouvre pendant le scraping :
le mode undetected franchit la verification tout seul la plupart du temps ;
si une case "Verify you are human" apparait, coche-la UNE fois et le script
reprend automatiquement.

En headless, le script active automatiquement le CDP Mode de SeleniumBase,
plus discret que les appels WebDriver classiques.

Usage :
    python capterra_scraper.py
    python capterra_scraper.py --url "https://www.capterra.com/p/157515/Spendesk/reviews/" --delay 3
    python capterra_scraper.py --max-pages 2      # test rapide
    python capterra_scraper.py --headless         # headless + CDP Mode + solve_captcha()
    python capterra_scraper.py --cdp-mode         # CDP Mode meme avec fenetre visible

Dependances :
    pip install seleniumbase beautifulsoup4 requests
    (SeleniumBase telecharge son propre chromedriver au premier lancement)

Parsing : 3 strategies essayees dans l'ordre :
  1. Analyse heuristique du HTML (le plus complet quand disponible)
  2. JSON embarque __NEXT_DATA__ (fallback fiable)
  3. JSON-LD (schema.org Review)
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

DEFAULT_URL = "https://www.capterra.com/p/157515/Spendesk/reviews/"

DATE_RE = re.compile(r"\b([A-Z][a-z]+ \d{1,2}, \d{4})\b")
RATING_RE = re.compile(r"\b([1-5]\.\d)\b")


# --------------------------------------------------------------------------
# Telechargement d'une page via SeleniumBase (attend la fin du challenge CF)
# --------------------------------------------------------------------------

def _open_page(sb, url, reconnect_time, cdp_mode):
    if cdp_mode:
        sb.activate_cdp_mode()
        sb.goto(url)
    else:
        sb.uc_open_with_reconnect(url, reconnect_time=reconnect_time)


def fetch_page(sb, url, reconnect_time=6, max_wait=180, headless=False, cdp_mode=False):
    """Ouvre une page en mode UC et attend le contenu reel des avis.
    En CDP/headless, tente de resoudre le challenge avec sb.solve_captcha().
    En mode visible, invite l'utilisateur si une action manuelle reste requise."""
    _open_page(sb, url, reconnect_time, cdp_mode)
    time.sleep(2)
    try:
        sb.solve_captcha()
    except Exception:
        pass

    prompted = False
    captcha_attempts = 1
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            html = sb.get_page_source()
            title = (sb.get_title() or "").lower()
        except Exception:
            time.sleep(2)
            continue

        low = html.lower()
        challenge = (
            "just a moment" in title
            or "verify you are human" in low
            or "performing security verification" in low
            or "checking your browser" in low
            or "cf-chl" in low
            or "turnstile" in low
        )
        if not challenge and ("Reviews" in html or "__NEXT_DATA__" in html):
            return html
        if challenge and not prompted:
            if headless or cdp_mode:
                print("  >> Verification Cloudflare detectee en mode CDP/headless : "
                      "je tente sb.solve_captcha() automatiquement...")
            else:
                print("  >> Verification Cloudflare : si une case 'Verify you are human' "
                      "s'affiche dans la fenetre Chrome, coche-la. J'attends...")
            prompted = True
        if challenge and captcha_attempts < 5:
            try:
                sb.solve_captcha()
            except Exception:
                pass
            captcha_attempts += 1
        time.sleep(2)

    return sb.get_page_source()


# --------------------------------------------------------------------------
# Strategie 1 : __NEXT_DATA__ (JSON Next.js embarque dans la page)
# --------------------------------------------------------------------------

REVIEW_KEY_HINTS = {
    "pros", "cons", "prostext", "constext", "reviewtext", "generalcomments",
    "overallrating", "reviewer", "reviewtitle", "writtenon",
}


def _find_review_arrays(obj, found):
    if isinstance(obj, list):
        if obj and all(isinstance(x, dict) for x in obj):
            keys = {k.lower() for x in obj[:3] for k in x}
            if len(keys & REVIEW_KEY_HINTS) >= 2:
                found.append(obj)
        for x in obj:
            _find_review_arrays(x, found)
    elif isinstance(obj, dict):
        for v in obj.values():
            _find_review_arrays(v, found)


def _flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(_flatten(v, key + "."))
        elif isinstance(v, list):
            out[key] = "; ".join(str(x) for x in v) if v else ""
        else:
            out[key] = v
    return out


def parse_next_data(soup):
    tag = soup.find("script", id="__NEXT_DATA__")
    if not tag or not tag.string:
        return []
    try:
        data = json.loads(tag.string)
    except json.JSONDecodeError:
        return []
    found = []
    _find_review_arrays(data, found)
    if not found:
        return []
    reviews = max(found, key=len)
    return [_flatten(r) for r in reviews]


# --------------------------------------------------------------------------
# Strategie 2 : JSON-LD (schema.org)
# --------------------------------------------------------------------------

def parse_json_ld(soup):
    reviews = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            candidates = item.get("review", [])
            if item.get("@type") == "Review":
                candidates = [item]
            if isinstance(candidates, dict):
                candidates = [candidates]
            for rev in candidates:
                if not isinstance(rev, dict):
                    continue
                author = rev.get("author", {})
                rating = rev.get("reviewRating", {})
                reviews.append({
                    "reviewer": author.get("name", "") if isinstance(author, dict) else str(author),
                    "title": rev.get("name", ""),
                    "date": rev.get("datePublished", ""),
                    "rating": rating.get("ratingValue", "") if isinstance(rating, dict) else "",
                    "summary": rev.get("reviewBody", ""),
                    "text": rev.get("reviewBody", ""),
                })
    return reviews


# --------------------------------------------------------------------------
# Strategie 3 : heuristique HTML (reperes "Pros" / "Cons")
# --------------------------------------------------------------------------

def _card_ancestor(node):
    cur = node
    for _ in range(8):
        cur = cur.parent
        if cur is None:
            return None
        text = cur.get_text(" ", strip=True)
        if "Pros" in text and "Cons" in text and cur.find(["h3", "h4"]):
            return cur
    return None


def _section_text(card, label):
    for el in card.find_all(string=re.compile(rf"^\s*{label}\s*$")):
        holder = el.parent
        for candidate in (holder.find_next_sibling(), holder.parent.find_next_sibling()):
            if candidate:
                txt = candidate.get_text(" ", strip=True)
                if txt and txt not in ("Pros", "Cons"):
                    return txt
    return ""


def _clean_text(text):
    return re.sub(r"[ \t\r\f\v]+", " ", text or "").strip()


def _lines(el):
    if not el:
        return []
    return [_clean_text(line) for line in el.get_text("\n", strip=True).split("\n") if _clean_text(line)]


def _first_number(text):
    m = re.search(r"\b(\d+(?:\.\d+)?)\b", text or "")
    return m.group(1) if m else ""


def _rating_from_testid(card, testid):
    node = card.find(attrs={"data-testid": testid})
    return _first_number(node.get_text(" ", strip=True)) if node else ""


def _reviewer_details(card):
    title_el = card.find(["h3", "h4"])
    search_root = title_el.find_previous() if title_el else card
    name_el = search_root.find_previous("span", class_=re.compile(r"font-semibold")) if title_el else None
    if not name_el:
        name_el = card.find("span", class_=re.compile(r"font-semibold"))

    name = _clean_text(name_el.get_text(" ", strip=True)) if name_el else ""
    block = name_el.parent if name_el else None
    detail_lines = _lines(block)
    if detail_lines and detail_lines[0] == name:
        detail_lines = detail_lines[1:]

    used_for = ""
    clean_details = []
    for line in detail_lines:
        if line.lower().startswith("used the software for:"):
            used_for = line.split(":", 1)[1].strip()
        else:
            clean_details.append(line)

    return {
        "reviewer": name,
        "reviewer_role": clean_details[0] if len(clean_details) > 0 else "",
        "reviewer_industry": clean_details[1] if len(clean_details) > 1 else "",
        "used_software_for": used_for,
        "reviewer_info": " | ".join(clean_details),
    }


def _ratings(card):
    ratings = {
        "rating": _rating_from_testid(card, "rating"),
        "rating_overall": _rating_from_testid(card, "Overall Rating-rating"),
        "rating_ease_of_use": _rating_from_testid(card, "Ease of Use-rating"),
        "rating_features": _rating_from_testid(card, "Features-rating"),
        "rating_value_for_money": _rating_from_testid(card, "Value for Money-rating"),
        "likelihood_to_recommend": "",
    }
    if not ratings["rating"] and ratings["rating_overall"]:
        ratings["rating"] = ratings["rating_overall"]

    likelihood = card.find(string=re.compile(r"Likelihood to Recommend", re.I))
    if likelihood:
        parent = likelihood.parent
        for _ in range(4):
            if not parent:
                break
            text = parent.get_text(" ", strip=True)
            m = re.search(r"\b(\d+(?:\.\d+)?)/10\b", text)
            if m:
                ratings["likelihood_to_recommend"] = m.group(1)
                break
            parent = parent.parent
    return ratings


def _review_source(card):
    source = card.find(attrs={"aria-labelledby": "review-source-label"})
    if not source:
        return "", ""
    text = source.get_text(" ", strip=True)
    tooltip = ""
    tip = source.find(attrs={"role": "dialog"})
    if tip:
        tooltip = tip.get_text(" ", strip=True)
    return text, tooltip


def _vendor_response(card):
    label = card.find(string=re.compile(r"^\s*Response from\s+", re.I))
    if not label:
        return {}
    holder = label.parent
    title = _clean_text(holder.get_text(" ", strip=True)) if holder else _clean_text(label)
    date_text = ""
    if holder:
        lines = _lines(holder.parent)
        for line in lines:
            if DATE_RE.search(line):
                date_text = DATE_RE.search(line).group(1)
                break
    response_text = ""
    response_block = holder.parent.find_next_sibling() if holder and holder.parent else None
    if response_block:
        response_text = response_block.get_text("\n", strip=True)
    return {
        "vendor_response_author": title,
        "vendor_response_date": date_text,
        "vendor_response": response_text,
    }


def _main_review_text(card, title_el):
    if not title_el:
        return ""
    for p in title_el.find_all_next("p"):
        section = p.find_previous(string=re.compile(r"^\s*(Pros|Cons)\s*$"))
        if section:
            break
        text = p.get_text(" ", strip=True)
        if text:
            return text
    return ""


def _summary_from_lines(card, title):
    """Fallback when the review summary is not rendered as a simple <p>."""
    lines = _lines(card)
    if not lines:
        return ""

    title_idx = -1
    if title:
        for i, line in enumerate(lines):
            if line.strip('"“”') == title:
                title_idx = i
                break

    boundary_patterns = (
        r"^pros$",
        r"^cons$",
        r"^positive icon$",
        r"^negative icon$",
        r"^continue reading$",
        r"^view less$",
        r"^overall rating$",
        r"^ease of use$",
        r"^customer service$",
        r"^features$",
        r"^value for money$",
        r"^likelihood to recommend$",
        r"^review source",
        r"^response from\s+",
        r"^used the software for:",
        r"^alternatives considered$",
        r"^reason for choosing",
        r"^switched from$",
        r"^\d+(?:\.\d+)?(?:/10)?$",
        r"^\d+\s*%$",
        r"^\d+$",
    )

    def is_boundary(line):
        clean = line.strip().strip('"“”')
        if not clean:
            return True
        if DATE_RE.search(clean):
            return True
        return any(re.search(pattern, clean, re.I) for pattern in boundary_patterns)

    def is_summary_line(line):
        clean = line.strip().strip('"“”')
        if len(clean) < 28:
            return False
        if title and clean == title:
            return False
        if is_boundary(clean):
            return False
        return True

    if title_idx > 0:
        before = []
        for line in reversed(lines[:title_idx]):
            clean = line.strip().strip('"“”')
            if is_boundary(clean):
                break
            if is_summary_line(clean):
                before.append(clean)
        before.reverse()
        if before:
            return " ".join(before)

    start = title_idx + 1 if title_idx >= 0 else 0
    stop = len(lines)
    for i in range(start, len(lines)):
        if lines[i] in ("Pros", "Cons"):
            stop = i
            break

    candidates = []
    for line in lines[start:stop]:
        clean = line.strip().strip('"“”')
        if not is_summary_line(clean):
            continue
        candidates.append(clean)

    return " ".join(candidates[:2]) if candidates else ""


def _first_present(review, names):
    lowered = {str(k).lower(): v for k, v in review.items()}
    for name in names:
        if name.lower() in lowered and lowered[name.lower()]:
            return lowered[name.lower()]
    for key, value in lowered.items():
        if value and any(key.endswith(name.lower()) for name in names):
            return value
    return ""


def _canonicalize_review(review):
    """Expose stable fields even when the source parser uses Capterra/JSON names."""
    review = dict(review)
    if not review.get("title"):
        review["title"] = _first_present(review, ["reviewTitle", "name"])
    if not review.get("date"):
        review["date"] = _first_present(review, ["writtenOn", "datePublished", "date"])
    if not review.get("rating"):
        review["rating"] = _first_present(review, ["overallRating", "ratingValue", "rating"])
    if not review.get("summary"):
        review["summary"] = _first_present(review, [
            "summary",
            "generalComments",
            "reviewText",
            "reviewBody",
            "text",
            "comments",
        ])
    if not review.get("pros"):
        review["pros"] = _first_present(review, ["pros", "prosText"])
    if not review.get("cons"):
        review["cons"] = _first_present(review, ["cons", "consText"])
    return review


def parse_html_cards(soup):
    reviews, seen = [], set()
    for label in soup.find_all(string=re.compile(r"^\s*Pros\s*$")):
        card = _card_ancestor(label.parent)
        if card is None or id(card) in seen:
            continue
        seen.add(id(card))
        text = card.get_text("\n", strip=True)
        title_el = card.find(["h3", "h4"])
        title = title_el.get_text(strip=True).strip('"“”') if title_el else ""
        m_date = DATE_RE.search(text)
        review_source, review_source_detail = _review_source(card)

        review = {
            "title": title,
            "date": m_date.group(1) if m_date else "",
            "summary": _main_review_text(card, title_el) or _summary_from_lines(card, title),
            "pros": _section_text(card, "Pros"),
            "cons": _section_text(card, "Cons"),
            "review_source": review_source,
            "review_source_detail": review_source_detail,
            "raw_text": text,
        }
        review.update(_reviewer_details(card))
        review.update(_ratings(card))
        review.update(_vendor_response(card))
        reviews.append(review)
    return reviews


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------

def parse_page(html):
    soup = BeautifulSoup(html, "html.parser")
    for strategy in (parse_html_cards, parse_next_data, parse_json_ld):
        reviews = strategy(soup)
        if reviews:
            return [_canonicalize_review(review) for review in reviews], strategy.__name__
    return [], None


def total_reviews(html):
    m = re.search(r"Showing [\d,]+-[\d,]+ of ([\d,]+) Reviews", html)
    return int(m.group(1).replace(",", "")) if m else None


def _normalize_for_fingerprint(value):
    if isinstance(value, dict):
        return {
            str(k): _normalize_for_fingerprint(v)
            for k, v in sorted(value.items())
            if not str(k).startswith("_")
        }
    if isinstance(value, list):
        return [_normalize_for_fingerprint(v) for v in value]
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip().lower()


def review_fingerprint(r):
    normalized = _normalize_for_fingerprint(r)
    payload = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def add_review_metadata(reviews, slug, source_url):
    scraped_at = datetime.now(timezone.utc).isoformat()
    for review in reviews:
        review["_fingerprint"] = review_fingerprint(review)
        review["_product_slug"] = slug
        review["_source_url"] = source_url
        review["_scraped_at"] = scraped_at
    return reviews


def scrape(url, delay, max_pages, out_dir, headless=False, cdp_mode=False):
    from seleniumbase import SB

    out_dir.mkdir(parents=True, exist_ok=True)
    debug_dir = out_dir / "debug"

    all_reviews, seen = [], set()
    total = None
    use_cdp_mode = cdp_mode or headless

    with SB(uc=True, headless=headless, headed=not headless, locale_code="en") as sb:
        page = 1
        while True:
            page_url = url if page == 1 else f"{url.rstrip('/')}/?page={page}"
            print(f"Page {page} : {page_url}")
            html = fetch_page(sb, page_url, headless=headless, cdp_mode=use_cdp_mode)

            if total is None:
                total = total_reviews(html)
                if total:
                    print(f"  -> {total} avis au total annonces")

            reviews, strategy = parse_page(html)
            if not reviews:
                debug_dir.mkdir(exist_ok=True)
                dump = debug_dir / f"page_{page}.html"
                dump.write_text(html, encoding="utf-8")
                print(f"  !! Aucun avis extrait, HTML sauve dans {dump}")
                break

            new = 0
            duplicates = 0
            for r in reviews:
                fp = review_fingerprint(r)
                if fp not in seen:
                    seen.add(fp)
                    r["_page"] = page
                    all_reviews.append(r)
                    new += 1
                else:
                    duplicates += 1
            print(f"  -> {len(reviews)} avis ({new} nouveaux, {duplicates} doublons exacts) "
                  f"[parseur : {strategy}]")

            if new == 0:
                break
            if total and len(all_reviews) >= total:
                break
            if max_pages and page >= max_pages:
                break
            page += 1
            time.sleep(delay)

    return all_reviews


def export(reviews, out_dir, slug):
    stamp = date.today().isoformat()
    json_path = out_dir / f"{slug}_avis_{stamp}.json"
    csv_path = out_dir / f"{slug}_avis_{stamp}.csv"

    json_path.write_text(
        json.dumps(reviews, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    fields = []
    for r in reviews:
        for k in r:
            if k not in fields:
                fields.append(k)
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(reviews)

    return csv_path, json_path


def _supabase_config(args):
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY", "")
    table = args.supabase_table or os.getenv("SUPABASE_TABLE") or "capterra_reviews"
    return url, key, table


def _chunked(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def upload_to_supabase(reviews, table, supabase_url, supabase_key):
    import requests

    endpoint = f"{supabase_url}/rest/v1/{table}?on_conflict=fingerprint"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    rows = []
    for review in reviews:
        rows.append({
            "fingerprint": review.get("_fingerprint") or review_fingerprint(review),
            "product_slug": review.get("_product_slug", ""),
            "source_url": review.get("_source_url", ""),
            "review_date": review.get("date", ""),
            "reviewer": review.get("reviewer", ""),
            "title": review.get("title", ""),
            "rating": review.get("rating", ""),
            "page": review.get("_page"),
            "scraped_at": review.get("_scraped_at"),
            "data": review,
        })

    total = 0
    for batch in _chunked(rows, 500):
        response = requests.post(endpoint, headers=headers, json=batch, timeout=60)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Erreur Supabase {response.status_code}: {response.text[:1000]}"
            )
        total += len(batch)
    return total


def main():
    ap = argparse.ArgumentParser(description="Scraper d'avis Capterra (SeleniumBase UC)")
    ap.add_argument("--url", default=DEFAULT_URL, help="URL de la page d'avis Capterra")
    ap.add_argument("--delay", type=float, default=2.5, help="Pause entre pages (s)")
    ap.add_argument("--max-pages", type=int, default=0, help="Limite de pages (0 = tout)")
    ap.add_argument("--out", default="resultats", help="Dossier de sortie")
    ap.add_argument("--headless", action="store_true",
                    help="Navigateur invisible (peut etre davantage bloque par Cloudflare)")
    ap.add_argument("--cdp-mode", action="store_true",
                    help="Active le CDP Mode SeleniumBase (automatique avec --headless)")
    ap.add_argument("--supabase", action="store_true",
                    help="Force l'upload Supabase et echoue si les variables manquent")
    ap.add_argument("--no-supabase", action="store_true",
                    help="Desactive l'upload Supabase meme si les variables sont presentes")
    ap.add_argument("--supabase-table", default="",
                    help="Table Supabase cible (defaut: capterra_reviews)")
    args = ap.parse_args()

    m = re.search(r"/p/\d+/([^/]+)/", args.url)
    slug = (m.group(1) if m else "capterra").lower()

    out_dir = Path(args.out)
    reviews = scrape(
        args.url,
        args.delay,
        args.max_pages,
        out_dir,
        headless=args.headless,
        cdp_mode=args.cdp_mode,
    )
    if not reviews:
        sys.exit("Aucun avis recupere. Voir le dossier debug/ pour le HTML brut.")

    add_review_metadata(reviews, slug, args.url)
    csv_path, json_path = export(reviews, out_dir, slug)
    print(f"\n{len(reviews)} avis exportes :\n  {csv_path}\n  {json_path}")

    supabase_url, supabase_key, supabase_table = _supabase_config(args)
    should_upload = not args.no_supabase and bool(supabase_url and supabase_key)
    if args.supabase and not should_upload:
        sys.exit("Supabase active, mais SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY manquent.")
    if should_upload:
        uploaded = upload_to_supabase(reviews, supabase_table, supabase_url, supabase_key)
        print(f"{uploaded} avis upsertes dans Supabase ({supabase_table}).")


if __name__ == "__main__":
    main()
