import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  BarChart3,
  Bell,
  CheckCircle2,
  Database,
  Download,
  LayoutDashboard,
  MessageSquareText,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  TrendingUp,
} from "lucide-react";
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

function sentimentForRating(ratingValue) {
  const rating = asNumber(ratingValue);
  if (rating === null) return "Neutral";
  if (rating >= 4) return "Positive";
  if (rating <= 2) return "Negative";
  return "Neutral";
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
    const item = buckets.get(key) || { month: key, count: 0 };
    item.count += 1;
    buckets.set(key, item);
  }
  return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
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

function getKeywordCloud(reviews) {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "you", "your", "our", "can", "was",
    "very", "have", "has", "but", "not", "all", "more", "use", "using", "easy", "great", "good",
    "les", "des", "une", "pour", "dans", "avec", "est", "pas", "sur", "nous", "vous", "très",
  ]);
  const counts = new Map();
  for (const review of reviews) {
    const data = review.data || {};
    const text = `${data.summary || ""} ${data.pros || ""} ${data.cons || ""}`.toLowerCase();
    const words = text.match(/[a-zÀ-ÿ][a-zÀ-ÿ'-]{3,}/g) || [];
    for (const word of words) {
      const clean = word.replace(/^['-]+|['-]+$/g, "");
      if (stopWords.has(clean)) continue;
      counts.set(clean, (counts.get(clean) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([word, count], index) => ({ word, count, tone: index % 4 }));
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

function NavItem({ icon: Icon, label, active }) {
  return (
    <a className={`nav-item ${active ? "active" : ""}`} href="#">
      <Icon size={20} />
      <span>{label}</span>
    </a>
  );
}

function Metric({ label, value, detail, accent }) {
  return (
    <section className={`metric ${accent || ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

function SentimentDonut({ stats }) {
  const total = Math.max(1, stats.positive + stats.neutral + stats.negative);
  const positive = Math.round((stats.positive / total) * 100);
  const neutral = Math.round((stats.neutral / total) * 100);
  const negative = Math.max(0, 100 - positive - neutral);
  return (
    <div className="sentiment-card panel">
      <div className="panel-heading spread">
        <div>
          <p className="overline">Overall sentiment</p>
          <h2>{stats.average}</h2>
        </div>
        <span className="chip success">Live</span>
      </div>
      <div className="donut-wrap">
        <svg className="donut" viewBox="0 0 36 36" aria-label="Sentiment chart">
          <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#edf1f4" strokeWidth="4" />
          <circle
            cx="18"
            cy="18"
            r="15.915"
            fill="transparent"
            stroke="#009485"
            strokeDasharray={`${positive} ${100 - positive}`}
            strokeDashoffset="0"
            strokeLinecap="round"
            strokeWidth="4"
          />
          <circle
            cx="18"
            cy="18"
            r="15.915"
            fill="transparent"
            stroke="#6063ee"
            strokeDasharray={`${neutral} ${100 - neutral}`}
            strokeDashoffset={`-${positive}`}
            strokeLinecap="round"
            strokeWidth="4"
          />
          <circle
            cx="18"
            cy="18"
            r="15.915"
            fill="transparent"
            stroke="#ba1a1a"
            strokeDasharray={`${negative} ${100 - negative}`}
            strokeDashoffset={`-${positive + neutral}`}
            strokeLinecap="round"
            strokeWidth="4"
          />
        </svg>
        <div className="donut-center">
          <strong>{positive}%</strong>
          <span>Positive</span>
        </div>
      </div>
      <div className="sentiment-split">
        <span><strong>{positive}%</strong> Positive</span>
        <span><strong>{neutral}%</strong> Neutral</span>
        <span><strong>{negative}%</strong> Negative</span>
      </div>
    </div>
  );
}

function RatingBars({ distribution }) {
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
          <div className="trend-column" style={{ height: `${Math.max(8, (item.count / max) * 132)}px` }} />
          <span>{item.month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function KeywordCloud({ words }) {
  return (
    <div className="keyword-cloud">
      {words.map((item) => (
        <span className={`keyword tone-${item.tone}`} key={item.word}>
          {item.word}
          <small>{item.count}</small>
        </span>
      ))}
    </div>
  );
}

function Stars({ rating }) {
  const rounded = Math.round(asNumber(rating) || 0);
  return (
    <div className="stars" aria-label={`${rating || 0} stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star key={star} size={15} fill={star <= rounded ? "currentColor" : "none"} />
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
  const [sentimentFilter, setSentimentFilter] = useState("all");
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
      const sentiment = sentimentForRating(review.rating);
      const matchesRating = ratingFilter === "all" || Math.round(rating || 0) === Number(ratingFilter);
      const matchesSentiment = sentimentFilter === "all" || sentiment === sentimentFilter;
      const matchesQuery = !q || reviewText(review).includes(q);
      return matchesRating && matchesSentiment && matchesQuery;
    });
    return items.sort((a, b) => {
      if (sortMode === "rating-desc") return (asNumber(b.rating) || 0) - (asNumber(a.rating) || 0);
      if (sortMode === "rating-asc") return (asNumber(a.rating) || 0) - (asNumber(b.rating) || 0);
      return String(b.review_date || b.created_at || "").localeCompare(String(a.review_date || a.created_at || ""));
    });
  }, [reviews, query, ratingFilter, sentimentFilter, sortMode]);

  const stats = useMemo(() => {
    const ratings = reviews.map((review) => asNumber(review.rating)).filter((rating) => rating !== null);
    const avg = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
    const products = new Set(reviews.map((review) => review.product_slug).filter(Boolean));
    const positive = reviews.filter((review) => sentimentForRating(review.rating) === "Positive").length;
    const neutral = reviews.filter((review) => sentimentForRating(review.rating) === "Neutral").length;
    const negative = reviews.filter((review) => sentimentForRating(review.rating) === "Negative").length;
    return {
      total: reviews.length,
      average: avg.toFixed(2),
      products: products.size,
      withResponse: reviews.filter((review) => review.data?.vendor_response).length,
      positive,
      neutral,
      negative,
    };
  }, [reviews]);

  const distribution = useMemo(() => getDistribution(reviews), [reviews]);
  const monthly = useMemo(() => buildMonthlySeries(reviews), [reviews]);
  const keywords = useMemo(() => getKeywordCloud(reviews), [reviews]);

  return (
    <div className="app-shell">
      <aside className="side-nav">
        <div className="brand">
          <strong>Spendesk <span>Insights</span></strong>
          <small>Capterra Analytics</small>
        </div>
        <nav>
          <NavItem icon={LayoutDashboard} label="Overview" />
          <NavItem icon={BarChart3} label="Sentiment" active />
          <NavItem icon={MessageSquareText} label="Reviews" active />
          <NavItem icon={TrendingUp} label="Trends" />
        </nav>
        <div className="nav-footer">
          <NavItem icon={Settings} label="Settings" />
        </div>
      </aside>

      <header className="topbar">
        <label className="global-search">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search every review field" />
        </label>
        <div className="top-actions">
          <button className="round-button" aria-label="Notifications">
            <Bell size={18} />
          </button>
          <button className="primary-button" onClick={load}>
            <RefreshCw size={17} />
            Refresh
          </button>
        </div>
      </header>

      <main className="content">
        <section className="hero">
          <div>
            <span className="status-pill">
              <Sparkles size={14} />
              Extracting: Spendesk
            </span>
            <h1>Review Intelligence</h1>
            <p>Analyse publique des retours Capterra, synchronisee depuis Supabase et chargee en integralite.</p>
          </div>
          <button className="secondary-button" onClick={() => exportCsv(filtered)}>
            <Download size={17} />
            Export CSV
          </button>
        </section>

        {error && (
          <div className="notice" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        <section className="metrics-grid">
          <Metric label="Reviews loaded" value={loading ? "..." : stats.total} detail="all rows fetched" accent="dark" />
          <Metric label="Average rating" value={loading ? "..." : stats.average} detail="Capterra score" />
          <Metric label="Products" value={loading ? "..." : stats.products} detail="unique slugs" />
          <Metric label="Vendor replies" value={loading ? "..." : stats.withResponse} detail="answered reviews" />
        </section>

        <section className="insight-grid">
          <SentimentDonut stats={stats} />
          <div className="panel keyword-panel">
            <div className="panel-heading spread">
              <div>
                <p className="overline">Voice of customer</p>
                <h2>Keyword Cloud</h2>
              </div>
              <span className="chip">{keywords.length} terms</span>
            </div>
            <KeywordCloud words={keywords} />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <Star size={18} />
              <h2>Rating Distribution</h2>
            </div>
            <RatingBars distribution={distribution} />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <Database size={18} />
              <h2>Monthly Volume</h2>
            </div>
            <Trend series={monthly} />
          </div>
        </section>

        <section className="workspace">
          <section className="feed">
            <div className="section-heading">
              <div>
                <p className="overline">Review feed</p>
                <h2>All Reviews</h2>
              </div>
              <span>{loading ? "Loading..." : `${filtered.length} shown / ${reviews.length} total`}</span>
            </div>

            <div className="review-list">
              {filtered.map((review) => {
                const data = review.data || {};
                const sentiment = sentimentForRating(review.rating);
                return (
                  <article className="review-card" key={review.fingerprint}>
                    <div className="review-head">
                      <div className="avatar" aria-hidden="true">
                        {(review.reviewer || "U").slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <h3>{review.reviewer || "Verified Reviewer"}</h3>
                        <div className="review-meta">
                          <span>{data.reviewer_role || "Reviewer"}</span>
                          <span>{formatDate(review.review_date)}</span>
                        </div>
                      </div>
                      <div className="review-rating">
                        <Stars rating={review.rating} />
                        <span className={`sentiment-badge ${sentiment.toLowerCase()}`}>{sentiment}</span>
                      </div>
                    </div>
                    <div className="verdict">
                      <span>Overall verdict</span>
                      <strong>{review.title || "Untitled review"}</strong>
                      {data.summary && <p>{data.summary}</p>}
                    </div>
                    <div className="pros-cons">
                      {data.pros && (
                        <div className="pros">
                          <span><CheckCircle2 size={15} /> Pros</span>
                          <p>{data.pros}</p>
                        </div>
                      )}
                      {data.cons && (
                        <div className="cons">
                          <span><AlertCircle size={15} /> Cons</span>
                          <p>{data.cons}</p>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
              {!loading && filtered.length === 0 && <div className="empty">No reviews match these filters.</div>}
            </div>
          </section>

          <aside className="filters">
            <div className="filter-title">
              <SlidersHorizontal size={18} />
              <h2>Filters</h2>
            </div>

            <label>
              Rating
              <select value={ratingFilter} onChange={(event) => setRatingFilter(event.target.value)} aria-label="Filter by rating">
                <option value="all">All ratings</option>
                <option value="5">5 stars</option>
                <option value="4">4 stars</option>
                <option value="3">3 stars</option>
                <option value="2">2 stars</option>
                <option value="1">1 star</option>
              </select>
            </label>

            <label>
              Sentiment
              <select value={sentimentFilter} onChange={(event) => setSentimentFilter(event.target.value)} aria-label="Filter by sentiment">
                <option value="all">All sentiments</option>
                <option value="Positive">Positive</option>
                <option value="Neutral">Neutral</option>
                <option value="Negative">Negative</option>
              </select>
            </label>

            <label>
              Sort
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort reviews">
                <option value="date-desc">Newest first</option>
                <option value="rating-desc">Best rating</option>
                <option value="rating-asc">Lowest rating</option>
              </select>
            </label>

            <div className="scrape-status">
              <span>Scrape Status</span>
              <strong>{stats.total}</strong>
              <small>Total reviews synced</small>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
