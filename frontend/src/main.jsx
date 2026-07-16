import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertCircle, ArrowDownUp, Database, Download, RefreshCw, Search, Star } from "lucide-react";
import "./styles.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const TABLE = import.meta.env.VITE_SUPABASE_TABLE || "capterra_reviews";
const PAGE_SIZE = 1000;

function asNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function formatDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
}

function reviewText(review) {
  const data = review.data || {};
  return [
    review.title,
    review.reviewer,
    data.summary,
    data.pros,
    data.cons,
    data.reviewer_role,
    data.reviewer_industry,
    data.vendor_response,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

async function fetchAllReviews() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.");
  }

  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const url = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("order", "review_date.desc.nullslast,created_at.desc");

    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${from}-${to}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase ${response.status}: ${body}`);
    }

    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function buildMonthlySeries(reviews) {
  const buckets = new Map();
  for (const review of reviews) {
    const raw = review.review_date || review.created_at;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) continue;
    const key = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
    const rating = asNumber(review.rating);
    const item = buckets.get(key) || { month: key, count: 0, ratingSum: 0, ratingCount: 0 };
    item.count += 1;
    if (rating !== null) {
      item.ratingSum += rating;
      item.ratingCount += 1;
    }
    buckets.set(key, item);
  }
  return [...buckets.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((item) => ({
      ...item,
      avgRating: item.ratingCount ? item.ratingSum / item.ratingCount : 0,
    }));
}

function getDistribution(reviews) {
  const buckets = new Map([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
  for (const review of reviews) {
    const rating = asNumber(review.rating);
    if (rating === null) continue;
    const rounded = Math.max(1, Math.min(5, Math.round(rating)));
    buckets.set(rounded, (buckets.get(rounded) || 0) + 1);
  }
  return [...buckets.entries()].map(([rating, count]) => ({ rating, count }));
}

function exportCsv(reviews) {
  const columns = ["review_date", "reviewer", "title", "rating", "product_slug", "summary", "pros", "cons"];
  const lines = [
    columns.join(","),
    ...reviews.map((review) => {
      const data = review.data || {};
      const row = {
        ...review,
        summary: data.summary || "",
        pros: data.pros || "",
        cons: data.cons || "",
      };
      return columns
        .map((column) => `"${String(row[column] || "").replaceAll('"', '""')}"`)
        .join(",");
    }),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "capterra_reviews.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function Metric({ label, value, detail }) {
  return (
    <section className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

function BarChart({ distribution }) {
  const max = Math.max(1, ...distribution.map((item) => item.count));
  return (
    <div className="bars" aria-label="Rating distribution">
      {distribution.map((item) => (
        <div className="bar-row" key={item.rating}>
          <span>{item.rating}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(item.count / max) * 100}%` }} />
          </div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

function Trend({ series }) {
  const max = Math.max(1, ...series.map((item) => item.count));
  const visible = series.slice(-14);
  return (
    <div className="trend" aria-label="Monthly review volume">
      {visible.map((item) => (
        <div className="trend-item" key={item.month}>
          <div className="trend-column" style={{ height: `${Math.max(8, (item.count / max) * 120)}px` }} />
          <span>{item.month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [ratingFilter, setRatingFilter] = useState("all");
  const [sortMode, setSortMode] = useState("date-desc");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setReviews(await fetchAllReviews());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = reviews.filter((review) => {
      const rating = asNumber(review.rating);
      const matchesRating = ratingFilter === "all" || Math.round(rating || 0) === Number(ratingFilter);
      const matchesQuery = !q || reviewText(review).includes(q);
      return matchesRating && matchesQuery;
    });
    return items.sort((a, b) => {
      if (sortMode === "rating-desc") return (asNumber(b.rating) || 0) - (asNumber(a.rating) || 0);
      if (sortMode === "rating-asc") return (asNumber(a.rating) || 0) - (asNumber(b.rating) || 0);
      return String(b.review_date || b.created_at || "").localeCompare(String(a.review_date || a.created_at || ""));
    });
  }, [reviews, query, ratingFilter, sortMode]);

  const stats = useMemo(() => {
    const ratings = reviews.map((review) => asNumber(review.rating)).filter((rating) => rating !== null);
    const avg = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
    const products = new Set(reviews.map((review) => review.product_slug).filter(Boolean));
    return {
      total: reviews.length,
      avg: avg.toFixed(2),
      products: products.size,
      withResponse: reviews.filter((review) => review.data?.vendor_response).length,
    };
  }, [reviews]);

  const distribution = useMemo(() => getDistribution(reviews), [reviews]);
  const monthly = useMemo(() => buildMonthlySeries(reviews), [reviews]);

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Public analytics</p>
          <h1>Capterra Reviews</h1>
        </div>
        <button className="icon-button" onClick={load} aria-label="Refresh reviews">
          <RefreshCw size={18} />
        </button>
      </header>

      {error && (
        <div className="notice" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      <section className="metrics-grid">
        <Metric label="Reviews loaded" value={loading ? "..." : stats.total} detail="all rows fetched from Supabase" />
        <Metric label="Average rating" value={loading ? "..." : stats.avg} detail="from stored ratings" />
        <Metric label="Products" value={loading ? "..." : stats.products} detail="unique product slugs" />
        <Metric label="Vendor responses" value={loading ? "..." : stats.withResponse} detail="reviews with reply text" />
      </section>

      <section className="analytics-grid">
        <div className="panel">
          <div className="panel-heading">
            <Star size={18} />
            <h2>Rating Distribution</h2>
          </div>
          <BarChart distribution={distribution} />
        </div>

        <div className="panel">
          <div className="panel-heading">
            <Database size={18} />
            <h2>Monthly Volume</h2>
          </div>
          <Trend series={monthly} />
        </div>
      </section>

      <section className="table-section">
        <div className="toolbar">
          <label className="search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search all review fields" />
          </label>
          <select value={ratingFilter} onChange={(event) => setRatingFilter(event.target.value)} aria-label="Filter by rating">
            <option value="all">All ratings</option>
            <option value="5">5 stars</option>
            <option value="4">4 stars</option>
            <option value="3">3 stars</option>
            <option value="2">2 stars</option>
            <option value="1">1 star</option>
          </select>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort reviews">
            <option value="date-desc">Newest first</option>
            <option value="rating-desc">Best rating</option>
            <option value="rating-asc">Lowest rating</option>
          </select>
          <button className="text-button" onClick={() => exportCsv(filtered)}>
            <Download size={16} />
            Export CSV
          </button>
        </div>

        <div className="table-title">
          <h2>All Reviews</h2>
          <span>{loading ? "Loading..." : `${filtered.length} shown / ${reviews.length} total`}</span>
        </div>

        <div className="review-list">
          {filtered.map((review) => {
            const data = review.data || {};
            return (
              <article className="review-row" key={review.fingerprint}>
                <div className="review-main">
                  <div className="review-meta">
                    <span>{formatDate(review.review_date)}</span>
                    <span>{review.product_slug}</span>
                    <span>{review.reviewer || "Anonymous"}</span>
                  </div>
                  <h3>{review.title || "Untitled review"}</h3>
                  {data.summary && <p>{data.summary}</p>}
                  <dl>
                    {data.pros && (
                      <>
                        <dt>Pros</dt>
                        <dd>{data.pros}</dd>
                      </>
                    )}
                    {data.cons && (
                      <>
                        <dt>Cons</dt>
                        <dd>{data.cons}</dd>
                      </>
                    )}
                  </dl>
                </div>
                <div className="review-score">
                  <ArrowDownUp size={16} />
                  <strong>{review.rating || "-"}</strong>
                </div>
              </article>
            );
          })}
          {!loading && filtered.length === 0 && <div className="empty">No reviews match these filters.</div>}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
