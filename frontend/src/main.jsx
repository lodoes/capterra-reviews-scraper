import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  BarChart3,
  Bell,
  CalendarDays,
  CheckCircle2,
  Download,
  LayoutDashboard,
  MessageSquareText,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  ThumbsDown,
  ThumbsUp,
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

function NavItem({ icon: Icon, label, active, onClick }) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} type="button">
      <Icon size={20} />
      <span>{label}</span>
    </button>
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

function TopicList({ title, tone, icon: Icon, items }) {
  return (
    <section className={`topic-card ${tone}`}>
      <div className="topic-title">
        <div className="topic-icon">
          <Icon size={20} />
        </div>
        <h2>{title}</h2>
      </div>
      <div className="topic-list">
        {items.length ? items.map((item) => (
          <article className="topic-item" key={item.word}>
            <div className="topic-bullet">{item.count}</div>
            <div>
              <strong>{item.word}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        )) : (
          <article className="topic-item">
            <div className="topic-bullet">0</div>
            <div>
              <strong>No data yet</strong>
              <p>Run the scraper or adjust public Supabase access.</p>
            </div>
          </article>
        )}
      </div>
    </section>
  );
}

function OverviewPage({ reviews, filtered, stats, monthly, keywords, loading, onExport, setActivePage }) {
  const latest = filtered.slice(0, 5);
  const maxMonthly = Math.max(1, ...monthly.map((item) => item.count));
  const positivePct = stats.total ? Math.round((stats.positive / stats.total) * 100) : 0;
  const negativePct = stats.total ? Math.round((stats.negative / stats.total) * 100) : 0;
  const pros = keywords.slice(0, 3).map((item) => ({
    ...item,
    detail: `Mentioned ${item.count} times across summary, pros, and cons.`,
  }));
  const cons = keywords.slice(3, 6).map((item) => ({
    ...item,
    detail: `Recurring theme to inspect in the review feed.`,
  }));

  return (
    <>
      <section className="overview-header">
        <div>
          <h1>Overview Dashboard</h1>
          <p>Real-time synthesis of user feedback, review volume, and sentiment trends.</p>
        </div>
        <div className="overview-actions">
          <button className="secondary-button" type="button">
            <CalendarDays size={17} />
            All Time
          </button>
          <button className="primary-button" onClick={onExport} type="button">
            <Download size={17} />
            Export CSV
          </button>
        </div>
      </section>

      <section className="overview-kpis">
        <Metric label="Overall Rating" value={loading ? "..." : `${stats.average}/5`} detail="average Capterra rating" />
        <Metric label="Total Reviews" value={loading ? "..." : stats.total} detail="all rows loaded from Supabase" />
        <Metric label="Sentiment Score" value={loading ? "..." : `${positivePct}%`} detail="reviews rated 4 stars or more" />
        <section className="metric status-metric">
          <span>Scrape Status</span>
          <strong>{loading ? "..." : "Live"}</strong>
          <small>{reviews.length} records synced</small>
        </section>
      </section>

      <section className="overview-grid">
        <section className="overview-chart panel">
          <div className="panel-heading spread">
            <div>
              <h2>Review Volume</h2>
              <p className="muted">Monthly ingestion trend</p>
            </div>
            <span className="chip">Total Reviews</span>
          </div>
          <div className="line-chart" aria-label="Review volume over time">
            <svg viewBox="0 0 640 240" preserveAspectRatio="none">
              <defs>
                <linearGradient id="volumeGradient" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="rgba(70, 72, 212, 0.22)" />
                  <stop offset="100%" stopColor="rgba(70, 72, 212, 0)" />
                </linearGradient>
              </defs>
              {monthly.length > 1 && (
                <>
                  <polyline
                    fill="none"
                    points={monthly.slice(-8).map((item, index, arr) => {
                      const x = (index / Math.max(1, arr.length - 1)) * 640;
                      const y = 218 - (item.count / maxMonthly) * 178;
                      return `${x},${y}`;
                    }).join(" ")}
                    stroke="#4648d4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="4"
                  />
                  <polygon
                    fill="url(#volumeGradient)"
                    points={`0,240 ${monthly.slice(-8).map((item, index, arr) => {
                      const x = (index / Math.max(1, arr.length - 1)) * 640;
                      const y = 218 - (item.count / maxMonthly) * 178;
                      return `${x},${y}`;
                    }).join(" ")} 640,240`}
                  />
                </>
              )}
            </svg>
            <div className="axis-labels">
              {monthly.slice(-6).map((item) => <span key={item.month}>{item.month}</span>)}
            </div>
          </div>
        </section>

        <section className="recent-sentiment panel">
          <div className="panel-heading">
            <Sparkles size={18} />
            <h2>Recent Sentiment</h2>
          </div>
          <div className="sentiment-bars">
            <div>
              <div className="sentiment-line">
                <span className="positive-text">Positive</span>
                <strong>{stats.positive} reviews</strong>
              </div>
              <div className="soft-track"><div className="positive-fill" style={{ width: `${positivePct}%` }} /></div>
            </div>
            <div>
              <div className="sentiment-line">
                <span className="negative-text">Negative</span>
                <strong>{stats.negative} reviews</strong>
              </div>
              <div className="soft-track"><div className="negative-fill" style={{ width: `${negativePct}%` }} /></div>
            </div>
          </div>
          <div className="ai-summary">
            <Sparkles size={18} />
            <p><strong>AI Summary:</strong> Overall feedback is led by high-rating reviews, with recurring themes visible in the keyword cloud.</p>
          </div>
        </section>
      </section>

      <section className="topics-grid">
        <TopicList title="Top Pros" tone="positive" icon={ThumbsUp} items={pros} />
        <TopicList title="Top Cons" tone="negative" icon={ThumbsDown} items={cons} />
      </section>

      <section className="latest-table">
        <div className="section-heading">
          <div>
            <p className="overline">Latest synthesized reviews</p>
            <h2>Recent Reviews</h2>
          </div>
          <button className="link-button" onClick={() => setActivePage("reviews")} type="button">View All Reviews</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Rating</th>
                <th>Key Topic</th>
                <th>Sentiment</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {latest.map((review) => {
                const data = review.data || {};
                const sentiment = sentimentForRating(review.rating);
                return (
                  <tr key={review.fingerprint}>
                    <td>{review.reviewer || "Verified Reviewer"}</td>
                    <td><Stars rating={review.rating} /></td>
                    <td>{data.reviewer_role || review.title || "Review"}</td>
                    <td><span className={`sentiment-badge ${sentiment.toLowerCase()}`}>{sentiment}</span></td>
                    <td>{formatDate(review.review_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function SentimentPage({
  reviews,
  stats,
  keywords,
  loading,
  error,
  onExport,
}) {
  const positivePct = stats.total ? Math.round((stats.positive / stats.total) * 100) : 0;
  const neutralPct = stats.total ? Math.round((stats.neutral / stats.total) * 100) : 0;
  const negativePct = Math.max(0, 100 - positivePct - neutralPct);
  const avgWords = reviews.length
    ? Math.round(reviews.reduce((sum, review) => sum + reviewText(review).split(/\s+/).filter(Boolean).length, 0) / reviews.length)
    : 0;
  const nps = stats.total ? Math.round(((stats.positive - stats.negative) / stats.total) * 100) : 0;
  const categorySpecs = [
    {
      name: "Features",
      words: ["feature", "fonction", "card", "carte", "approval", "workflow", "automated", "virtual"],
      fallback: "Virtual cards and automated approvals are top tier.",
    },
    {
      name: "Pricing",
      words: ["price", "pricing", "cost", "expensive", "plan", "prix", "tarif", "cher"],
      fallback: "Value is high, but pricing needs monitoring for SMBs.",
    },
    {
      name: "Ease of Use",
      words: ["easy", "simple", "intuitive", "facile", "rapide", "use", "ux"],
      fallback: "Users repeatedly mention speed, clarity, and low friction.",
    },
    {
      name: "Support",
      words: ["support", "customer", "service", "help", "assistance", "response", "réponse"],
      fallback: "Support quality remains a category to track closely.",
    },
  ];
  const categoryRows = categorySpecs.map((category) => {
    const matches = reviews.filter((review) => {
      const text = reviewText(review);
      return category.words.some((word) => text.includes(word));
    });
    const source = matches.length ? matches : reviews;
    const ratings = source.map((review) => asNumber(review.rating)).filter((rating) => rating !== null);
    const average = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
    const score = Number(average.toFixed(1));
    const sentiment = score >= 4.6 ? "Peak" : score >= 4 ? "High" : score >= 3 ? "Mixed" : "Declining";
    const tone = score >= 4 ? "positive" : score >= 3 ? "neutral" : "negative";
    const volume = matches.length || 0;
    const sample = matches.find((review) => review.data?.summary || review.title);
    return {
      ...category,
      score,
      sentiment,
      tone,
      volume,
      takeaway: sample?.data?.summary || sample?.title || category.fallback,
    };
  });

  return (
    <>
      <section className="sentiment-header">
        <div>
          <h1>Sentiment Analysis</h1>
          <p>A welcoming overview of real-time user perception synthesis across {reviews.length} detailed reviews.</p>
        </div>
        <div className="overview-actions">
          <button className="secondary-button" onClick={onExport} type="button">
            <Download size={17} />
            Export
          </button>
          <button className="primary-button" type="button">
            <RefreshCw size={17} />
            Update Scan
          </button>
        </div>
      </section>

      {error && (
        <div className="notice" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      <section className="sentiment-grid">
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
      </section>

      <section className="category-performance">
        <div className="category-heading">
          <h2>Categorized Performance</h2>
          <button className="secondary-button" type="button">Last 30 Days</button>
        </div>
        <div className="category-table-wrap">
          <table className="category-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Score</th>
                <th>Sentiment Trend</th>
                <th>Key Takeaway</th>
                <th>Volume</th>
              </tr>
            </thead>
            <tbody>
              {categoryRows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td><span className={`score-pill ${row.tone}`}>{row.score || "..."}</span></td>
                  <td>
                    <div className="trend-inline">
                      <div className="trend-track">
                        <div className={`trend-fill ${row.tone}`} style={{ width: `${Math.max(8, (row.score / 5) * 100)}%` }} />
                      </div>
                      <span className={row.tone}>{row.sentiment}</span>
                    </div>
                  </td>
                  <td><em>"{row.takeaway}"</em></td>
                  <td>{row.volume} reviews</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sentiment-bento">
        <article className="sentiment-metric-card">
          <h2>Net Promoter Score</h2>
          <div className="big-number">{nps}</div>
          <div className="mini-track-label">
            <span>Promoters ({positivePct}%)</span>
            <strong>{stats.positive}</strong>
          </div>
          <div className="soft-track"><div className="positive-fill" style={{ width: `${positivePct}%` }} /></div>
        </article>
        <article className="sentiment-metric-card">
          <h2>Avg. Review Length</h2>
          <div className="big-number">{avgWords} <span>words</span></div>
          <p>Users are providing detailed feedback, indicating trust and engagement with the platform's core workflows.</p>
        </article>
        <article className="sentiment-synthesis">
          <h2>Strategic Synthesis</h2>
          <p>Overall sentiment is {positivePct >= 70 ? "strongly positive" : "balanced"}, with {positivePct}% positive reviews, {neutralPct}% neutral reviews, and {negativePct}% negative reviews. Pricing and support remain the categories to monitor.</p>
        </article>
      </section>
    </>
  );
}

function ReviewsPage({
  filtered,
  reviews,
  stats,
  loading,
  error,
  onExport,
  ratingFilter,
  setRatingFilter,
  sentimentFilter,
  setSentimentFilter,
  sortMode,
  setSortMode,
}) {
  return (
    <section className="reviews-page">
      <div className="reviews-main">
        <section className="reviews-header">
          <div>
            <span className="status-pill">Extracting: Spendesk</span>
            <h1>Review Feed</h1>
            <p>Latest verified feedback from Capterra users, loaded from Supabase.</p>
          </div>
          <button className="secondary-button" onClick={onExport} type="button">
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

        <div className="review-list spacious">
          {filtered.map((review) => {
            const data = review.data || {};
            const sentiment = sentimentForRating(review.rating);
            return (
              <article className="review-card large" key={review.fingerprint}>
                <div className="review-head">
                  <div className="avatar large-avatar" aria-hidden="true">
                    {(review.reviewer || "U").slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <h3>{review.reviewer || "Verified Reviewer"}</h3>
                    <div className="review-meta">
                      <span>{data.reviewer_role || data.reviewer_industry || "Capterra reviewer"}</span>
                      <span>{formatDate(review.review_date)}</span>
                    </div>
                  </div>
                  <div className="review-rating">
                    <Stars rating={review.rating} />
                    <span className={`sentiment-badge ${sentiment.toLowerCase()}`}>{sentiment}</span>
                  </div>
                </div>

                <div className="verdict featured">
                  <span>Overall verdict</span>
                  <strong>{review.title || "Untitled review"}</strong>
                  {data.summary && <p>{data.summary}</p>}
                </div>

                <div className="pros-cons">
                  <div className="pros">
                    <span><CheckCircle2 size={15} /> Pros</span>
                    <p>{data.pros || "No pros extracted for this review."}</p>
                  </div>
                  <div className="cons">
                    <span><AlertCircle size={15} /> Cons</span>
                    <p>{data.cons || "No cons extracted for this review."}</p>
                  </div>
                </div>
              </article>
            );
          })}
          {!loading && filtered.length === 0 && <div className="empty">No reviews match these filters.</div>}
          {loading && <div className="empty">Loading reviews...</div>}
        </div>
      </div>

      <aside className="reviews-filter-panel">
        <div className="filter-title">
          <SlidersHorizontal size={18} />
          <h2>Filters</h2>
        </div>

        <label>
          Filter by Rating
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
          Sentiment Analysis
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
          <small>{loading ? "Loading..." : `${filtered.length} reviews shown`}</small>
        </div>
      </aside>
    </section>
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
  const [activePage, setActivePage] = useState("overview");

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

  const sharedReviewProps = {
    filtered,
    reviews,
    stats,
    distribution,
    monthly,
    keywords,
    loading,
    error,
    onExport: () => exportCsv(filtered),
    ratingFilter,
    setRatingFilter,
    sentimentFilter,
    setSentimentFilter,
    sortMode,
    setSortMode,
  };

  return (
    <div className="app-shell">
      <aside className="side-nav">
        <div className="brand">
          <strong>Spendesk <span>Insights</span></strong>
          <small>Capterra Analytics</small>
        </div>
        <nav>
          <NavItem icon={LayoutDashboard} label="Overview" active={activePage === "overview"} onClick={() => setActivePage("overview")} />
          <NavItem icon={BarChart3} label="Sentiment" active={activePage === "sentiment"} onClick={() => setActivePage("sentiment")} />
          <NavItem icon={MessageSquareText} label="Reviews" active={activePage === "reviews"} onClick={() => setActivePage("reviews")} />
        </nav>
        <div className="nav-footer">
          <NavItem icon={Settings} label="Settings" active={false} onClick={() => setActivePage("overview")} />
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
        {error && activePage === "overview" && (
          <div className="notice" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        {activePage === "overview" ? (
          <OverviewPage
            reviews={reviews}
            filtered={filtered}
            stats={stats}
            monthly={monthly}
            keywords={keywords}
            loading={loading}
            onExport={() => exportCsv(filtered)}
            setActivePage={setActivePage}
          />
        ) : activePage === "reviews" ? (
          <ReviewsPage {...sharedReviewProps} />
        ) : (
          <SentimentPage {...sharedReviewProps} />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
