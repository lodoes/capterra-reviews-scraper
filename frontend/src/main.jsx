import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const TABLE = import.meta.env.VITE_SUPABASE_TABLE || "capterra_reviews";
const PAGE_SIZE = 1000;
const InsightsContext = createContext(null);

function asNumber(value) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

function formatDate(value) {
    const parsed = parseReviewDate(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
}

function parseReviewDate(value) {
    if (!value) return new Date(NaN);
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    return parsed;
}

function dateInputValue(date) {
    if (!date || Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
}

function sentimentForRating(value) {
    const rating = asNumber(value);
    if (rating === null) return "Neutral";
    if (rating >= 4) return "Positive";
    if (rating <= 2) return "Negative";
    return "Neutral";
}

function reviewText(review) {
    const data = review.data || {};
    return [review.title, review.reviewer, data.summary, data.pros, data.cons, data.reviewer_role, data.reviewer_industry]
        .filter(Boolean).join(" ").toLowerCase();
}

function isFilterableReview(review) {
    return asNumber(review.rating) !== null && !Number.isNaN(parseReviewDate(review.review_date_iso || review.review_date || review.created_at).getTime());
}

async function fetchAllReviews() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const to = from + PAGE_SIZE - 1;
        const url = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`);
        url.searchParams.set("select", "*");
        url.searchParams.set("order", "review_date.desc.nullslast,created_at.desc");
        const response = await fetch(url, {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${to}` },
        });
        if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
        const batch = await response.json();
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
    }
    return rows;
}

function getKeywords(reviews) {
    const stop = new Set("the and for with that this from are you your our can was very have has but not all more use using easy great good spendesk les des une pour dans avec est pas sur nous vous tres très outil avis simple utilisation".split(" "));
    const counts = new Map();
    for (const review of reviews) {
        const data = review.data || {};
        const text = `${data.summary || ""} ${data.pros || ""} ${data.cons || ""}`.toLowerCase();
        for (const raw of text.match(/[a-zÀ-ÿ][a-zÀ-ÿ'-]{3,}/g) || []) {
            const word = raw.replace(/^['-]+|['-]+$/g, "");
            if (stop.has(word)) continue;
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word, count]) => ({ word, count }));
}

function getMonthly(reviews) {
    const buckets = new Map();
    for (const review of reviews) {
        const parsed = new Date(review.review_date_iso || review.review_date || review.created_at);
        if (Number.isNaN(parsed.getTime())) continue;
        const key = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
        buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-6).map(([month, count]) => ({ month, count }));
}

function exportCsv(reviews) {
    const cols = ["review_date", "reviewer", "title", "rating", "summary", "pros", "cons"];
    const lines = [cols.join(","), ...reviews.map((review) => {
        const data = review.data || {};
        const row = { ...review, summary: data.summary || "", pros: data.pros || "", cons: data.cons || "" };
        return cols.map((col) => `"${String(row[col] || "").replaceAll('"', '""')}"`).join(",");
    })];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "capterra_reviews.csv";
    link.click();
    URL.revokeObjectURL(url);
}

function InsightsProvider({ children }) {
    const [reviews, setReviews] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [ratingFilter, setRatingFilter] = useState("all");
    const [sentimentFilter, setSentimentFilter] = useState("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    useEffect(() => {
        fetchAllReviews().then(setReviews).catch((err) => setError(err.message || String(err))).finally(() => setLoading(false));
    }, []);
    const value = useMemo(() => {
        const datedReviews = reviews
            .map((review) => ({ review, date: parseReviewDate(review.review_date || review.created_at) }))
            .filter((item) => !Number.isNaN(item.date.getTime()));
        const minDate = datedReviews.length ? new Date(Math.min(...datedReviews.map((item) => item.date.getTime()))) : null;
        const maxDate = datedReviews.length ? new Date(Math.max(...datedReviews.map((item) => item.date.getTime()))) : null;
        const fromDate = dateFrom ? parseReviewDate(dateFrom) : null;
        const toDate = dateTo ? parseReviewDate(dateTo) : null;
        if (toDate && !Number.isNaN(toDate.getTime())) {
            toDate.setHours(23, 59, 59, 999);
        }
        const q = query.trim().toLowerCase();
        const filteredReviews = reviews.filter((review) => {
            const rating = asNumber(review.rating);
            const reviewDate = parseReviewDate(review.review_date_iso || review.review_date || review.created_at);
            const matchesSearch = !q || reviewText(review).includes(q);
            const matchesRating = ratingFilter === "all" || Math.round(rating || 0) === Number(ratingFilter);
            const matchesSentiment = sentimentFilter === "all" || sentimentForRating(review.rating) === sentimentFilter;
            const matchesFrom = !fromDate || Number.isNaN(fromDate.getTime()) || (!Number.isNaN(reviewDate.getTime()) && reviewDate >= fromDate);
            const matchesTo = !toDate || Number.isNaN(toDate.getTime()) || (!Number.isNaN(reviewDate.getTime()) && reviewDate <= toDate);
            return matchesSearch && matchesRating && matchesSentiment && matchesFrom && matchesTo;
        });
        const filterableCount = reviews.filter(isFilterableReview).length;
        const ratings = reviews.map((review) => asNumber(review.rating)).filter((rating) => rating !== null);
        const scopedRatings = filteredReviews.map((review) => asNumber(review.rating)).filter((rating) => rating !== null);
        const avg = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
        const scopedAvg = scopedRatings.length ? scopedRatings.reduce((sum, rating) => sum + rating, 0) / scopedRatings.length : 0;
        const positive = reviews.filter((review) => sentimentForRating(review.rating) === "Positive").length;
        const neutral = reviews.filter((review) => sentimentForRating(review.rating) === "Neutral").length;
        const negative = reviews.filter((review) => sentimentForRating(review.rating) === "Negative").length;
        const scopedPositive = filteredReviews.filter((review) => sentimentForRating(review.rating) === "Positive").length;
        const scopedNeutral = filteredReviews.filter((review) => sentimentForRating(review.rating) === "Neutral").length;
        const scopedNegative = filteredReviews.filter((review) => sentimentForRating(review.rating) === "Negative").length;
        const positivePct = reviews.length ? Math.round((positive / reviews.length) * 100) : 0;
        const negativePct = reviews.length ? Math.round((negative / reviews.length) * 100) : 0;
        const scopedPositivePct = filteredReviews.length ? Math.round((scopedPositive / filteredReviews.length) * 100) : 0;
        const scopedNegativePct = filteredReviews.length ? Math.round((scopedNegative / filteredReviews.length) * 100) : 0;
        const keywords = getKeywords(filteredReviews);
        const fallbackPros = [
            { icon: "speed", title: "User Interface Speed", desc: "Users consistently praise the responsiveness and fast loading times of the dashboards." },
            { icon: "account_balance_wallet", title: "Card Management", desc: "The ease of creating and disabling virtual cards is a major high point for finance teams." },
            { icon: "integration_instructions", title: "ERP Integrations", desc: "Seamless syncing with Xero and NetSuite reduces manual bookkeeping errors by 60%." },
        ];
        const fallbackCons = [
            { icon: "euro", title: "FX Fees Transparency", desc: "Some users find the foreign exchange fees slightly high compared to traditional bank rates." },
            { icon: "receipt_long", title: "Mobile OCR Accuracy", desc: "Minor feedback regarding occasional failures to read blurry paper receipts in low light." },
            { icon: "notifications_active", title: "Notification Density", desc: "Approvers note that they receive too many notification emails during peak spending cycles." },
        ];
        return {
            reviews,
            filteredReviews,
            loading,
            error,
            query,
            setQuery,
            ratingFilter,
            setRatingFilter,
            sentimentFilter,
            setSentimentFilter,
            dateFrom,
            setDateFrom,
            dateTo,
            setDateTo,
            minDate,
            maxDate,
            keywords,
            monthly: getMonthly(filteredReviews),
            topPros: buildHighlights(filteredReviews, "pros", fallbackPros),
            topCons: buildHighlights(filteredReviews, "cons", fallbackCons),
            categoryRows: buildCategoryRows(filteredReviews),
            analytics: {
                total: reviews.length,
                filtered: filteredReviews.length,
                filterable: filterableCount,
                unfilterable: Math.max(0, reviews.length - filterableCount),
                totalLabel: reviews.length.toLocaleString("en-US"),
                filteredLabel: filteredReviews.length.toLocaleString("en-US"),
                filterableLabel: filterableCount.toLocaleString("en-US"),
                average: avg ? avg.toFixed(1) : "0.0",
                scopedAverage: scopedAvg ? scopedAvg.toFixed(1) : "0.0",
                positive,
                neutral,
                negative,
                scopedPositive,
                scopedNeutral,
                scopedNegative,
                positivePct,
                neutralPct: reviews.length ? Math.round((neutral / reviews.length) * 100) : 0,
                negativePct,
                scopedPositivePct,
                scopedNeutralPct: filteredReviews.length ? Math.round((scopedNeutral / filteredReviews.length) * 100) : 0,
                scopedNegativePct,
                positivePctLabel: `${positivePct}%`,
                negativePctLabel: `${negativePct}%`,
                scopedPositivePctLabel: `${scopedPositivePct}%`,
                scopedNegativePctLabel: `${scopedNegativePct}%`,
                statusLabel: loading ? "Loading" : "Live Sync",
            },
        };
    }, [reviews, loading, error, query, ratingFilter, sentimentFilter, dateFrom, dateTo]);
    return <InsightsContext.Provider value={value}>{children}</InsightsContext.Provider>;
}

function useInsights() {
    return useContext(InsightsContext);
}

function reviewToCard(review, idx) {
    const data = review.data || {};
    return {
        name: review.reviewer || "Verified Reviewer",
        role: data.reviewer_role || data.reviewer_industry || "Capterra reviewer",
        date: formatDate(review.review_date_iso || review.review_date),
        img: `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(review.reviewer || `review-${idx}`)}`,
        rating: Math.round(asNumber(review.rating) || 0),
        sentiment: sentimentForRating(review.rating),
        verdict: data.summary || review.title || "No summary extracted for this review.",
        pros: data.pros || "No pros extracted for this review.",
        cons: data.cons || "No cons extracted for this review.",
    };
}

function compactText(value, fallback) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return fallback;
    return text.length > 190 ? `${text.slice(0, 187)}...` : text;
}

function buildHighlights(reviews, field, fallbackItems) {
    const icons = field === "pros"
        ? ["speed", "account_balance_wallet", "integration_instructions"]
        : ["euro", "receipt_long", "notifications_active"];
    const stop = new Set("the and for with that this from are you your our can was very have has but not all more use using easy great good spendesk les des une pour dans avec est pas sur nous vous tres très outil avis simple utilisation software system platform".split(" "));
    const counts = new Map();
    const examples = new Map();
    for (const review of reviews) {
        const text = String(review.data?.[field] || "");
        if (!text || text.length < 25) continue;
        const words = text.toLowerCase().match(/[a-zÀ-ÿ][a-zÀ-ÿ'-]{3,}/g) || [];
        for (const raw of words) {
            const word = raw.replace(/^['-]+|['-]+$/g, "");
            if (stop.has(word)) continue;
            counts.set(word, (counts.get(word) || 0) + 1);
            if (!examples.has(word)) examples.set(word, text);
        }
    }
    const source = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!source.length) return fallbackItems;
    return source.map(([word, count], idx) => ({
        icon: icons[idx % icons.length],
        title: `${word.replace(/^\w/, (c) => c.toUpperCase())} (${count} mentions)`,
        desc: compactText(examples.get(word), ""),
    }));
}

function buildCategoryRows(reviews) {
    const specs = [
        { cat: "Features", words: ["feature", "features", "card", "virtual", "workflow", "approval"], quote: '"Virtual cards and automated approvals are top tier."' },
        { cat: "Pricing", words: ["price", "pricing", "cost", "expensive", "plan", "value", "money"], quote: '"Value is high, but entry price is steep for SMBs."' },
        { cat: "Ease of Use", words: ["easy", "simple", "intuitive", "facile", "ux", "quick", "fast"], quote: '"Incredibly intuitive UX, almost zero learning curve."' },
    ];
    return specs.map((spec) => {
        const matched = reviews.filter((review) => spec.words.some((word) => reviewText(review).includes(word)));
        const source = matched.length ? matched : reviews;
        const ratings = source.map((review) => asNumber(review.rating)).filter((rating) => rating !== null);
        const scoreNumber = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
        const score = scoreNumber ? scoreNumber.toFixed(1) : "0.0";
        const trendNumber = Math.round((scoreNumber / 5) * 100);
        const tone = scoreNumber >= 4 ? "positive" : scoreNumber >= 3 ? "neutral" : "negative";
        const sample = matched.find((review) => review.data?.summary || review.title);
        return {
            cat: spec.cat,
            score,
            color: tone === "positive" ? "bg-secondary-fixed text-on-secondary-fixed" : tone === "neutral" ? "bg-surface-container text-on-surface-variant" : "bg-error-container text-on-error-container",
            trend: `${Math.max(6, trendNumber)}%`,
            trendL: scoreNumber >= 4.6 ? "Peak" : scoreNumber >= 4 ? "High" : scoreNumber >= 3 ? "Mixed" : "Declining",
            trendC: tone === "positive" ? "bg-on-tertiary-container" : tone === "neutral" ? "bg-outline" : "bg-error",
            quote: `"${compactText(sample?.data?.summary || sample?.title, spec.quote.replaceAll('"', ""))}"`,
        };
    });
}
        // --- Shared Components ---

        const Sidebar = ({ activePage, setActivePage }) => {
    const navItems = [
        { path: 'overview', label: 'Overview', icon: 'dashboard' },
        { path: 'sentiment', label: 'Sentiment', icon: 'analytics' },
        { path: 'reviews', label: 'Reviews', icon: 'forum' }
    ];

    return (
        <aside className="w-64 h-full fixed left-0 top-0 bg-surface-container-lowest dark:bg-surface-container-lowest shadow-sm flex flex-col py-10 z-50">
            <div className="px-6 mb-10">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-secondary rounded-lg flex items-center justify-center">
                        <span className="material-symbols-outlined text-white" style={{fontVariationSettings: "'FILL' 1"}}>analytics</span>
                    </div>
                    <div>
                        <h1 className="text-headline-md font-bold text-primary leading-tight">Spendesk</h1>
                        <p className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-extrabold">Insights</p>
                    </div>
                </div>
            </div>
            <nav className="flex-grow space-y-1 px-4">
                {navItems.map(item => (
                    <button
                        key={item.path}
                        type="button"
                        onClick={() => setActivePage(item.path)}
                        className={`w-full flex items-center gap-3 px-4 py-3 transition-all duration-200 rounded-xl ${activePage === item.path ? 'text-secondary font-bold bg-secondary/5' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-primary'}`}
                    >
                        <span className="material-symbols-outlined" style={{fontVariationSettings: activePage === item.path ? "'FILL' 1" : ""}}>{item.icon}</span>
                        <span className="text-label-md">{item.label}</span>
                    </button>
                ))}
            </nav>
        </aside>
    );
};

        const TopBar = ({ title = "Search insights..." }) => {
            const { query, setQuery } = useInsights();
            return (
                <header className="fixed top-0 right-0 left-64 h-20 z-40 bg-surface/80 backdrop-blur-md flex justify-between items-center px-lg">
                    <div className="flex items-center flex-1 max-w-xl">
                        <div className="relative w-full">
                            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
                            <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full bg-surface-container-low border-none rounded-full pl-12 pr-6 py-2.5 text-label-md focus:ring-2 focus:ring-secondary/20 transition-all" placeholder={title} type="text"/>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <button className="relative w-10 h-10 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-all">
                            <span className="material-symbols-outlined">notifications</span>
                            <span className="absolute top-2 right-2 w-2 h-2 bg-error rounded-full border-2 border-surface"></span>
                        </button>
                        <div className="flex items-center gap-3 bg-surface-container-low hover:bg-surface-container-high p-1.5 pr-4 rounded-full transition-all cursor-pointer group">
                            <img className="w-10 h-10 rounded-full border-2 border-surface-container-high object-cover shadow-sm" src="/lotfi-profile.jpg"/>
                            <div className="hidden lg:block text-left ml-2">
                                <p className="text-label-md font-bold text-primary leading-tight group-hover:text-secondary transition-colors">Lotfi Boulefaa</p>
                                <p className="text-[10px] text-on-surface-variant font-label-sm uppercase tracking-widest">Admin</p>
                            </div>
                        </div>
                    </div>
                </header>
            );
        };

        // --- Pages ---

        const OverviewPage = () => {
            const { analytics, topPros, topCons, monthly, dateFrom, setDateFrom, dateTo, setDateTo, minDate, maxDate } = useInsights();
            const maxMonthly = Math.max(1, ...monthly.map((item) => item.count));
            const points = monthly.map((item, index) => {
                const x = monthly.length <= 1 ? 600 : (index / (monthly.length - 1)) * 600;
                const y = 190 - (item.count / maxMonthly) * 150;
                return `${x},${y}`;
            }).join(" ");
            return (
                <div className="animate-fade-in">
                    <TopBar />
                    <main className="ml-64 pt-28 pb-16 px-lg">
                        <div className="max-w-[1400px] mx-auto">
                            <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-4">
                                <div>
                                    <h2 className="text-display font-extrabold text-primary mb-1">Overview Dashboard</h2>
                                    <p className="text-on-surface-variant text-body-lg">Real-time synthesis of user feedback and sentiment signals.</p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <details className="relative">
                                        <summary className="list-none flex items-center gap-2 px-6 py-3 border border-outline-variant text-on-surface font-label-md rounded-full hover:bg-surface-container-low transition-all cursor-pointer">
                                            <span className="material-symbols-outlined text-[20px]">calendar_today</span>
                                            {dateFrom || dateTo ? `${dateFrom || dateInputValue(minDate)} - ${dateTo || dateInputValue(maxDate)}` : "Last 30 Days"}
                                        </summary>
                                        <div className="absolute right-0 mt-3 w-72 rounded-2xl bg-surface-container-lowest border border-outline-variant/40 p-4 shadow-xl z-50 space-y-3">
                                            <input className="w-full bg-surface-container-low border-none rounded-lg px-4 py-3 text-label-md focus:ring-2 focus:ring-secondary/20" type="date" value={dateFrom} min={dateInputValue(minDate)} max={dateInputValue(maxDate)} onChange={(event) => setDateFrom(event.target.value)} />
                                            <input className="w-full bg-surface-container-low border-none rounded-lg px-4 py-3 text-label-md focus:ring-2 focus:ring-secondary/20" type="date" value={dateTo} min={dateInputValue(minDate)} max={dateInputValue(maxDate)} onChange={(event) => setDateTo(event.target.value)} />
                                            <button type="button" onClick={() => { setDateFrom(""); setDateTo(""); }} className="w-full text-label-md font-bold text-secondary py-2">Reset dates</button>
                                        </div>
                                    </details>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-md mb-md">
                                <div className="bg-surface-container-lowest p-8 rounded-lg data-card-shadow">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-label-sm text-on-surface-variant uppercase tracking-widest font-bold">Overall Rating</span>
                                        <div className="w-10 h-10 rounded-full bg-secondary/10 flex items-center justify-center">
                                            <span className="material-symbols-outlined text-secondary text-[20px]" style={{fontVariationSettings: "'FILL' 1"}}>star</span>
                                        </div>
                                    </div>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-display text-primary">{analytics.scopedAverage}</span>
                                        <span className="text-on-surface-variant text-body-md">/ 5</span>
                                    </div>
                                </div>
                                <div className="bg-surface-container-lowest p-8 rounded-lg data-card-shadow">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-label-sm text-on-surface-variant uppercase tracking-widest font-bold">Total Reviews</span>
                                        <div className="w-10 h-10 rounded-full bg-secondary/10 flex items-center justify-center">
                                            <span className="material-symbols-outlined text-secondary text-[20px]">reviews</span>
                                        </div>
                                    </div>
                                    <div className="text-display text-primary">{analytics.filteredLabel}</div>
                                </div>
                                <div className="bg-surface-container-lowest p-8 rounded-lg data-card-shadow">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-label-sm text-on-surface-variant uppercase tracking-widest font-bold">Sentiment Score</span>
                                        <div className="w-10 h-10 rounded-full bg-secondary/10 flex items-center justify-center">
                                            <span className="material-symbols-outlined text-secondary text-[20px]">sentiment_satisfied</span>
                                        </div>
                                    </div>
                                    <div className="text-display text-primary">{analytics.scopedPositivePctLabel}</div>
                                    <div className="mt-4 flex items-center text-on-tertiary-container font-bold text-label-sm">
                                        <span className="material-symbols-outlined text-[16px] mr-1">check_circle</span>
                                        Stable synthesis
                                    </div>
                                </div>
                                <div className="bg-secondary p-8 rounded-lg data-card-shadow text-white relative overflow-hidden">
                                    <div className="relative z-10">
                                        <div className="flex items-center justify-between mb-4">
                                            <span className="text-label-sm text-secondary-fixed uppercase tracking-widest font-bold">Scrape Status</span>
                                            <span className="w-2.5 h-2.5 bg-tertiary-fixed-dim rounded-full animate-pulse shadow-[0_0_8px_rgba(79,219,200,0.8)]"></span>
                                        </div>
                                        <div className="text-headline-md font-extrabold mb-1">{analytics.statusLabel}</div>
                                        <p className="text-secondary-fixed/80 text-label-sm font-medium">{analytics.filteredLabel} matching / {analytics.totalLabel} loaded</p>
                                    </div>
                                    <div className="absolute right-[-20px] bottom-[-20px] opacity-10 rotate-12">
                                        <span className="material-symbols-outlined text-[160px]">hub</span>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-md mb-md">
                                <div className="lg:col-span-2 bg-surface-container-lowest p-8 rounded-lg data-card-shadow">
                                    <div className="flex items-center justify-between mb-8">
                                        <div>
                                            <h3 className="text-headline-md font-bold text-primary">Review Volume</h3>
                                            <p className="text-on-surface-variant text-body-md">Trends over the last 6 months</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="w-3 h-3 rounded-full bg-secondary"></span>
                                            <span className="text-label-sm font-bold text-on-surface-variant">Total Reviews</span>
                                        </div>
                                    </div>
                                    <div className="h-72 relative chart-grid border-l border-b border-outline-variant/30">
                                        <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none" viewBox="0 0 600 200">
                                            <defs>
                                                <linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1">
                                                    <stop offset="0%" stopColor="rgba(70, 72, 212, 0.15)"></stop>
                                                    <stop offset="100%" stopColor="rgba(70, 72, 212, 0)"></stop>
                                                </linearGradient>
                                            </defs>
                                            {monthly.length > 1 && <polyline points={points} fill="none" stroke="#4648d4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4"></polyline>}
                                            {monthly.length > 1 && <polygon points={`0,200 ${points} 600,200`} fill="url(#chartGradient)"></polygon>}
                                        </svg>
                                        <div className="absolute bottom-[-32px] left-0 w-full flex justify-between text-[11px] text-on-surface-variant uppercase font-extrabold tracking-widest">
                                            {monthly.map((item) => <span key={item.month}>{item.month}</span>)}
                                        </div>
                                    </div>
                                </div>
                                <div className="bg-surface-container-lowest p-8 rounded-lg data-card-shadow flex flex-col">
                                    <h3 className="text-headline-md font-bold text-primary mb-2">Recent Sentiment</h3>
                                    <p className="text-on-surface-variant text-body-sm mb-8">Aggregate feedback polarity from latest reviews.</p>
                                    <div className="space-y-8">
                                        <div>
                                            <div className="flex justify-between items-center mb-3">
                                                <span className="px-4 py-1.5 rounded-full bg-on-tertiary-container/10 text-on-tertiary-container text-label-sm font-extrabold">POSITIVE</span>
                                                <span className="text-label-md font-bold text-on-tertiary-container">{analytics.scopedPositive} Reviews</span>
                                            </div>
                                            <div className="w-full h-3 bg-surface-container-high rounded-full overflow-hidden">
                                                <div className="h-full bg-on-tertiary-container rounded-full" style={{width: analytics.scopedPositivePctLabel}}></div>
                                            </div>
                                        </div>
                                        <div>
                                            <div className="flex justify-between items-center mb-3">
                                                <span className="px-4 py-1.5 rounded-full bg-error/10 text-error text-label-sm font-extrabold">NEGATIVE</span>
                                                <span className="text-label-md font-bold text-error">{analytics.scopedNegative} Reviews</span>
                                            </div>
                                            <div className="w-full h-3 bg-surface-container-high rounded-full overflow-hidden">
                                                <div className="h-full bg-error rounded-full" style={{width: analytics.scopedNegativePctLabel}}></div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mt-auto pt-8 border-t border-outline-variant">
                                        <div className="flex items-start gap-4 p-5 rounded-lg bg-surface-container-low border border-on-tertiary-container/10 shadow-sm">
                                            <span className="material-symbols-outlined text-on-tertiary-container mt-0.5">auto_awesome</span>
                                            <div className="text-body-sm leading-relaxed">
                                                <span className="font-extrabold text-on-tertiary-container">AI Summary:</span> Overall sentiment is exceptionally strong in financial compliance.
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                                <div className="bg-surface-container-lowest rounded-lg data-card-shadow overflow-hidden">
                                    <div className="bg-on-tertiary-container/5 px-8 py-5 flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-on-tertiary-container/10 flex items-center justify-center">
                                            <span className="material-symbols-outlined text-on-tertiary-container">thumb_up</span>
                                        </div>
                                        <h3 className="text-headline-md font-extrabold text-on-tertiary-container">Top Pros</h3>
                                    </div>
                                    <div className="p-8 space-y-6">
                                        {topPros.map((pro, idx) => (
                                            <div key={idx} className="flex items-start gap-5">
                                                <div className="w-12 h-12 rounded-xl bg-surface-container-low flex items-center justify-center flex-shrink-0 text-secondary">
                                                    <span className="material-symbols-outlined">{pro.icon}</span>
                                                </div>
                                                <div>
                                                    <p className="font-extrabold text-body-lg text-primary">{pro.title}</p>
                                                    <p className="text-body-md text-on-surface-variant">{pro.desc}</p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div className="bg-surface-container-lowest rounded-lg data-card-shadow overflow-hidden">
                                    <div className="bg-error/5 px-8 py-5 flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-error/10 flex items-center justify-center">
                                            <span className="material-symbols-outlined text-error">thumb_down</span>
                                        </div>
                                        <h3 className="text-headline-md font-extrabold text-error">Top Cons</h3>
                                    </div>
                                    <div className="p-8 space-y-6">
                                        {topCons.map((con, idx) => (
                                            <div key={idx} className="flex items-start gap-5">
                                                <div className="w-12 h-12 rounded-xl bg-surface-container-low flex items-center justify-center flex-shrink-0 text-secondary">
                                                    <span className="material-symbols-outlined">{con.icon}</span>
                                                </div>
                                                <div>
                                                    <p className="font-extrabold text-body-lg text-primary">{con.title}</p>
                                                    <p className="text-body-md text-on-surface-variant">{con.desc}</p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </main>
                </div>
            );
        };

        const ReviewsPage = () => {
            const {
                reviews,
                filteredReviews,
                analytics,
                loading,
                ratingFilter,
                setRatingFilter,
                sentimentFilter,
                setSentimentFilter,
                dateFrom,
                setDateFrom,
                dateTo,
                setDateTo,
                minDate,
                maxDate,
            } = useInsights();
            const cards = filteredReviews.slice(0, 50).map(reviewToCard);
            return (
                <div className="animate-fade-in flex flex-col h-screen">
                    <TopBar title="Search reviews..." />
                    <main className="ml-64 pt-20 flex flex-1 overflow-hidden">
                        <section className="flex-1 overflow-y-auto px-container-padding py-10 bg-background">
                            <div className="max-w-4xl mx-auto space-y-8">
                                <div className="flex items-end justify-between mb-10">
                                    <div>
                                        <span className="text-[10px] font-bold text-on-tertiary-container bg-tertiary-fixed-dim/30 px-3 py-1 rounded-full uppercase tracking-[0.15em] mb-3 inline-block">Extracting: Spendesk</span>
                                        <h2 className="text-headline-lg font-bold text-primary tracking-tight">Review Feed</h2>
                                        <p className="text-on-surface-variant font-body-md mt-1 opacity-80">Latest verified feedback from Capterra users.</p>
                                    </div>
                                    <div className="flex gap-3">
                                        <button onClick={() => exportCsv(reviews)} className="flex items-center gap-2 px-6 py-2.5 bg-surface-container-lowest border border-outline-variant/30 text-label-md font-bold rounded-lg hover:bg-surface-container hover:border-secondary/30 hover:text-secondary transition-all shadow-sm">
                                            <span className="material-symbols-outlined text-[18px]">download</span>
                                            Export CSV
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-6">
                                    {cards.map((review, idx) => (
                                        <article key={idx} className="bg-surface-container-lowest border border-outline-variant/20 rounded-lg p-8 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
                                            <div className="flex items-start justify-between mb-6">
                                                <div className="flex items-center gap-5">
                                                    <img className="w-14 h-14 rounded-full object-cover ring-4 ring-surface-container-low" src={review.img}/>
                                                    <div>
                                                        <h3 className="font-bold text-primary text-body-lg">{review.name}</h3>
                                                        <div className="flex items-center gap-2 text-on-surface-variant font-label-md">
                                                            <span>{review.role}</span>
                                                            <span className="text-outline-variant opacity-50">•</span>
                                                            <time className="opacity-70">{review.date}</time>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="flex items-center text-secondary mb-2">
                                                        {[1,2,3,4,5].map(s => <span key={s} className="material-symbols-outlined text-lg" style={{fontVariationSettings: s <= review.rating ? "'FILL' 1" : ""}}>star</span>)}
                                                    </div>
                                                    <span className="text-[10px] font-extrabold text-on-tertiary-container bg-tertiary-fixed-dim/20 px-3 py-1 rounded-full uppercase tracking-wider">{review.sentiment}</span>
                                                </div>
                                            </div>
                                            <div className="space-y-6">
                                                <div>
                                                    <h4 className="font-label-sm text-secondary uppercase text-[10px] mb-2 font-extrabold tracking-widest opacity-80">Overall Verdict</h4>
                                                    <p className="text-body-lg font-semibold leading-relaxed text-primary">{review.verdict}</p>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                    <div className="bg-tertiary-fixed/10 p-5 rounded-lg border border-tertiary-fixed/20">
                                                        <h4 className="font-label-sm text-on-tertiary-container uppercase text-[10px] mb-3 flex items-center gap-2 font-extrabold tracking-widest">
                                                            <span className="material-symbols-outlined text-sm bg-tertiary-fixed-dim text-on-tertiary rounded-full p-0.5">add</span> Pros
                                                        </h4>
                                                        <p className="text-body-md text-on-surface-variant leading-relaxed">{review.pros}</p>
                                                    </div>
                                                    <div className="bg-error-container/10 p-5 rounded-lg border border-error-container/30">
                                                        <h4 className="font-label-sm text-error uppercase text-[10px] mb-3 flex items-center gap-2 font-extrabold tracking-widest">
                                                            <span className="material-symbols-outlined text-sm bg-error/10 rounded-full p-0.5">remove</span> Cons
                                                        </h4>
                                                        <p className="text-body-md text-on-surface-variant leading-relaxed">{review.cons}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </article>
                                    ))}
                                </div>
                                <div className="flex justify-center py-12">
                                    <button className="px-10 py-4 bg-primary text-on-primary font-extrabold rounded-lg shadow-lg hover:bg-secondary hover:scale-105 active:scale-95 transition-all">
                                        {loading ? "Loading Reviews" : `${cards.length} shown / ${analytics.filteredLabel} matching`}
                                    </button>
                                </div>
                            </div>
                        </section>

                        <aside className="w-80 h-full bg-surface-container-lowest border-l border-outline-variant/30 p-8 overflow-y-auto hidden xl:block">
                            <div className="flex items-center gap-3 mb-10">
                                <span className="material-symbols-outlined text-secondary bg-secondary/10 p-2 rounded-lg">tune</span>
                                <h3 className="font-headline-md text-headline-md font-extrabold text-primary">Filters</h3>
                            </div>
                            <div className="space-y-10">
                                <div className="space-y-4">
                                    <label className="font-label-sm text-on-surface-variant uppercase tracking-[0.15em] text-[10px] font-extrabold opacity-60">Filter by Rating</label>
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between group cursor-pointer hover:bg-surface-container-low p-2 rounded-lg transition-all">
                                            <div className="flex items-center gap-3">
                                                <select value={ratingFilter} onChange={(event) => setRatingFilter(event.target.value)} className="bg-surface-container-low border-none rounded-lg text-label-md px-3 py-2 focus:ring-secondary/20">
                                                    <option value="all">All ratings</option>
                                                    <option value="5">5 stars</option>
                                                    <option value="4">4 stars</option>
                                                    <option value="3">3 stars</option>
                                                    <option value="2">2 stars</option>
                                                    <option value="1">1 star</option>
                                                </select>
                                                <div className="flex items-center text-secondary text-sm">
                                                    {[1,2,3,4,5].map(s => <span key={s} className="material-symbols-outlined text-sm" style={{fontVariationSettings: "'FILL' 1"}}>star</span>)}
                                                </div>
                                            </div>
                                            <span className="text-label-md text-on-surface-variant font-bold">{analytics.filteredLabel}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-4">
                                    <label className="font-label-sm text-on-surface-variant uppercase tracking-[0.15em] text-[10px] font-extrabold opacity-60">Sentiment Analysis</label>
                                    <div className="grid grid-cols-1 gap-2">
                                        <button onClick={() => setSentimentFilter(sentimentFilter === "Positive" ? "all" : "Positive")} className={`flex items-center justify-between px-4 py-3 ${sentimentFilter === "Positive" ? "bg-secondary/10 border-secondary/30 text-secondary" : "bg-surface-container-low border-transparent text-on-surface-variant"} border rounded-lg text-label-md font-bold transition-all shadow-sm`}>
                                            Positive
                                            <span className="material-symbols-outlined text-sm" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                                        </button>
                                        <button onClick={() => setSentimentFilter(sentimentFilter === "Neutral" ? "all" : "Neutral")} className={`flex items-center justify-between px-4 py-3 ${sentimentFilter === "Neutral" ? "bg-secondary/10 border-secondary/30 text-secondary" : "bg-surface-container-low border-transparent text-on-surface-variant"} border rounded-lg text-label-md font-semibold hover:bg-surface-container-high transition-all`}>
                                            Neutral
                                            <span className="material-symbols-outlined text-sm">radio_button_unchecked</span>
                                        </button>
                                        <button onClick={() => setSentimentFilter(sentimentFilter === "Negative" ? "all" : "Negative")} className={`flex items-center justify-between px-4 py-3 ${sentimentFilter === "Negative" ? "bg-secondary/10 border-secondary/30 text-secondary" : "bg-surface-container-low border-transparent text-on-surface-variant"} border rounded-lg text-label-md font-semibold hover:bg-surface-container-high transition-all`}>
                                            Negative
                                            <span className="material-symbols-outlined text-sm">radio_button_unchecked</span>
                                        </button>
                                    </div>
                                </div>
                                <div className="space-y-4">
                                    <label className="font-label-sm text-on-surface-variant uppercase tracking-[0.15em] text-[10px] font-extrabold opacity-60">Review Date</label>
                                    <div className="space-y-3">
                                        <input className="w-full bg-surface-container-low border-none rounded-lg px-4 py-3 text-label-md focus:ring-2 focus:ring-secondary/20" type="date" value={dateFrom} min={dateInputValue(minDate)} max={dateInputValue(maxDate)} onChange={(event) => setDateFrom(event.target.value)} />
                                        <input className="w-full bg-surface-container-low border-none rounded-lg px-4 py-3 text-label-md focus:ring-2 focus:ring-secondary/20" type="date" value={dateTo} min={dateInputValue(minDate)} max={dateInputValue(maxDate)} onChange={(event) => setDateTo(event.target.value)} />
                                    </div>
                                </div>
                                <div className="pt-8 space-y-3">
                                    <button className="w-full py-4 bg-primary text-on-primary font-extrabold rounded-lg shadow-lg active:scale-95 hover:bg-secondary transition-all">{analytics.filteredLabel} MATCHING REVIEWS</button>
                                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                                        {analytics.totalLabel} rows loaded. {analytics.filterableLabel} are fully filterable by rating/date; {analytics.unfilterable} miss a parseable rating or review date, so strict filters can exclude them.
                                    </p>
                                </div>
                                <div className="p-6 bg-secondary-fixed/50 border border-secondary/10 rounded-lg space-y-3 mt-12 relative overflow-hidden">
                                    <div className="absolute -right-4 -top-4 w-16 h-16 bg-secondary/10 rounded-full blur-2xl"></div>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] uppercase font-extrabold text-secondary tracking-widest">Scrape Status</span>
                                        <span className="flex h-2.5 w-2.5 rounded-full bg-secondary animate-pulse"></span>
                                    </div>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-[40px] font-extrabold text-primary leading-none">{analytics.totalLabel}</span>
                                        <span className="text-label-md font-bold text-on-surface-variant opacity-70">Total</span>
                                    </div>
                                </div>
                            </div>
                        </aside>
                    </main>
                    <button className="fixed bottom-10 right-10 w-16 h-16 bg-secondary text-on-secondary rounded-full shadow-lg flex items-center justify-center hover:scale-110 active:scale-90 transition-all z-50 group">
                        <span className="material-symbols-outlined text-2xl">sync</span>
                    </button>
                </div>
            );
        };

        const SentimentPage = () => {
            const { analytics, keywords, categoryRows } = useInsights();
            const keywordTags = keywords.length
                ? keywords.map((item, idx) => ({
                    t: item.word,
                    c: idx % 4 === 0 ? "bg-on-tertiary-container text-white" : idx % 4 === 1 ? "bg-surface-container text-on-surface-variant" : idx % 4 === 2 ? "bg-secondary-fixed text-on-secondary-fixed-variant" : "bg-secondary-container text-on-secondary-container",
                    s: idx % 3 === 0 ? "font-headline-md px-8 py-4" : idx % 3 === 1 ? "font-body-md px-6 py-3" : "font-label-md px-5 py-2",
                }))
                : [
                    { t: 'Easy to use', c: 'bg-on-tertiary-container text-white', s: 'font-headline-md px-8 py-4' },
                    { t: 'Virtual Cards', c: 'bg-surface-container text-on-surface-variant', s: 'font-body-md px-6 py-3' },
                    { t: 'Expense Management', c: 'bg-secondary-fixed text-on-secondary-fixed-variant', s: 'font-body-md font-bold px-6 py-3' },
                ];
            return (
                <div className="animate-fade-in">
                    <TopBar title="Search sentiment analytics..." />
                    <main className="ml-64 pt-28 pb-16 px-lg">
                        <div className="max-w-[1440px] mx-auto space-y-10">
                            <div className="flex justify-between items-end">
                                <div>
                                    <h2 className="text-display font-bold text-primary mb-2">Sentiment Analysis</h2>
                                    <p className="text-body-md text-on-surface-variant max-w-xl">A welcoming overview of real-time user perception synthesis across {analytics.filteredLabel} matching reviews.</p>
                                </div>
                                <div className="flex gap-4">
                                    <button className="px-8 py-3 bg-white border border-outline-variant text-primary rounded-xl font-label-md hover:bg-surface-container transition-all shadow-sm">EXPORT</button>
                                    <button className="px-8 py-3 bg-secondary text-on-secondary rounded-xl font-label-md hover:bg-secondary-container transition-all shadow-md">UPDATE SCAN</button>
                                </div>
                            </div>

                            <div className="grid grid-cols-12 gap-6">
                                <div className="col-span-12 lg:col-span-5 bg-surface-container-lowest border border-outline-variant/50 p-8 rounded-lg shadow-sm hover:shadow-md transition-all">
                                    <div className="flex justify-between items-start mb-8">
                                        <div>
                                            <h3 className="font-label-md uppercase tracking-widest text-on-surface-variant mb-1">Overall Sentiment</h3>
                                            <div className="flex items-baseline gap-2">
                                                <span className="font-display text-headline-lg text-primary">{analytics.scopedAverage}</span>
                                                <span className="text-on-tertiary-container bg-tertiary-fixed px-3 py-0.5 rounded-full font-label-md">+8.4% vs LY</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-center justify-center h-64 relative">
                                        <svg className="w-56 h-56 transform -rotate-90" viewBox="0 0 36 36">
                                            <circle cx="18" cy="18" fill="transparent" r="15.915" stroke="#F1F5F9" strokeWidth="4"></circle>
                                            <circle cx="18" cy="18" fill="transparent" r="15.915" stroke="#009485" strokeDasharray="72 28" strokeDashoffset="0" strokeLinecap="round" strokeWidth="4"></circle>
                                            <circle cx="18" cy="18" fill="transparent" r="15.915" stroke="#6063ee" strokeDasharray="18 82" strokeDashoffset="-72" strokeLinecap="round" strokeWidth="4"></circle>
                                            <circle cx="18" cy="18" fill="transparent" r="15.915" stroke="#ba1a1a" strokeDasharray="10 90" strokeDashoffset="-90" strokeLinecap="round" strokeWidth="4"></circle>
                                        </svg>
                                        <div className="absolute flex flex-col items-center">
                                            <span className="font-display text-display text-primary leading-none">{analytics.scopedPositivePctLabel}</span>
                                            <span className="font-label-md text-on-surface-variant mt-1">POSITIVE</span>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-4 mt-10">
                                        <div className="text-center p-3 rounded-2xl bg-on-tertiary-container/5">
                                            <p className="text-on-tertiary-container font-bold text-lg">{analytics.scopedPositivePctLabel}</p>
                                            <p className="font-label-md text-on-surface-variant">Positive</p>
                                        </div>
                                        <div className="text-center p-3 rounded-2xl bg-secondary/5">
                                            <p className="text-secondary font-bold text-lg">{analytics.scopedNeutralPct}%</p>
                                            <p className="font-label-md text-on-surface-variant">Neutral</p>
                                        </div>
                                        <div className="text-center p-3 rounded-2xl bg-error/5">
                                            <p className="text-error font-bold text-lg">{analytics.scopedNegativePctLabel}</p>
                                            <p className="font-label-md text-on-surface-variant">Negative</p>
                                        </div>
                                    </div>
                                </div>

                                <div className="col-span-12 lg:col-span-7 bg-surface-container-lowest border border-outline-variant/50 p-8 rounded-lg shadow-sm hover:shadow-md transition-all">
                                    <h3 className="font-label-md uppercase tracking-widest text-on-surface-variant mb-8">Voice of Customer Keywords</h3>
                                    <div className="flex flex-wrap gap-4 h-[320px] content-start">
                                        {keywordTags.map((tag, idx) => (
                                            <span key={idx} className={`${tag.c} ${tag.s} rounded-xl cursor-pointer hover:scale-105 transition-all shadow-sm`}>{tag.t}</span>
                                        ))}
                                    </div>
                                </div>

                                <div className="col-span-12 bg-surface-container-lowest border border-outline-variant/50 p-8 rounded-lg shadow-sm">
                                    <div className="flex justify-between items-center mb-8">
                                        <h3 className="font-label-md uppercase tracking-widest text-on-surface-variant">Categorized Performance</h3>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left">
                                            <thead>
                                                <tr className="border-b border-outline-variant/30">
                                                    <th className="pb-6 font-label-md text-on-surface-variant px-2">CATEGORY</th>
                                                    <th className="pb-6 font-label-md text-on-surface-variant text-center px-2">SCORE</th>
                                                    <th className="pb-6 font-label-md text-on-surface-variant px-2">SENTIMENT TREND</th>
                                                    <th className="pb-6 font-label-md text-on-surface-variant px-2">KEY TAKEAWAY</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {categoryRows.map((row, idx) => (
                                                    <tr key={idx} className="border-b border-outline-variant/10 hover:bg-surface-container-low transition-all group cursor-pointer">
                                                        <td className="py-6 font-headline-md text-primary px-2">{row.cat}</td>
                                                        <td className="py-6 text-center px-2">
                                                            <div className={`inline-flex items-center justify-center w-12 h-12 rounded-2xl font-bold ${row.color}`}>{row.score}</div>
                                                        </td>
                                                        <td className="py-6 px-2">
                                                            <div className="flex items-center gap-3">
                                                                <div className="h-2 w-32 bg-surface-container rounded-full overflow-hidden">
                                                                    <div className={`h-full ${row.trendC} rounded-full`} style={{width: row.trend}}></div>
                                                                </div>
                                                                <span className={`font-label-md ${row.trendC.replace('bg-', 'text-')}`}>{row.trendL}</span>
                                                            </div>
                                                        </td>
                                                        <td className="py-6 text-body-md italic text-on-surface-variant px-2">{row.quote}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </main>
                </div>
            );
        };

const App = () => {
    const [activePage, setActivePage] = useState('overview');
    return (
        <InsightsProvider>
            <div className="flex bg-surface min-h-screen">
                <Sidebar activePage={activePage} setActivePage={setActivePage} />
                <div className="flex-1">
                    {activePage === 'reviews' ? <ReviewsPage /> : activePage === 'sentiment' ? <SentimentPage /> : <OverviewPage />}
                </div>
            </div>
        </InsightsProvider>
    );
};

createRoot(document.getElementById('root')).render(<App />);

