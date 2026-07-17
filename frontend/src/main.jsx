import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const TABLE = import.meta.env.VITE_SUPABASE_TABLE || "capterra_reviews";
const INSIGHTS_TABLE = import.meta.env.VITE_SUPABASE_INSIGHTS_TABLE || "capterra_review_insights";
const PAGE_SIZE = 1000;
const SEEN_REVIEWS_KEY = "spendesk_seen_review_fingerprints";
const MISTRAL_SETTINGS_KEY = "spendesk_mistral_ai_settings";
const InsightsContext = createContext(null);

const DEFAULT_MISTRAL_SETTINGS = {
    apiKey: "",
    model: "mistral-small-latest",
    prompt: "Group Capterra reviews into coherent business themes. Return clean keywords, top pros, top cons, and categorized performance with an overall synthesis. Avoid malformed words, raw stop words, generic brand-only terms, and vague labels.",
};

function asNumber(value) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

function formatDate(value) {
    const parsed = parseReviewDate(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
}

function formatDateTime(value) {
    const parsed = parseReviewDate(value);
    if (Number.isNaN(parsed.getTime())) return "Not synced yet";
    return parsed.toLocaleString("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
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

function reviewId(review) {
    return review.fingerprint || `${review.source_url || ""}-${review.reviewer || ""}-${review.title || ""}-${review.review_date || ""}`;
}

function readSeenReviewIds() {
    try {
        return new Set(JSON.parse(window.localStorage.getItem(SEEN_REVIEWS_KEY) || "[]"));
    } catch {
        return new Set();
    }
}

function writeSeenReviewIds(reviews) {
    try {
        window.localStorage.setItem(SEEN_REVIEWS_KEY, JSON.stringify(reviews.map(reviewId).filter(Boolean)));
    } catch {
        // localStorage can be blocked in private or embedded browsers.
    }
}

function detectNewReviews(reviews) {
    if (typeof window === "undefined") return [];
    try {
        const existingValue = window.localStorage.getItem(SEEN_REVIEWS_KEY);
        if (!existingValue) {
            writeSeenReviewIds(reviews);
            return [];
        }
    } catch {
        return [];
    }
    const seen = readSeenReviewIds();
    return reviews.filter((review) => {
        const id = reviewId(review);
        return id && !seen.has(id);
    }).slice(0, 10);
}

function readMistralSettings() {
    if (typeof window === "undefined") return DEFAULT_MISTRAL_SETTINGS;
    try {
        return { ...DEFAULT_MISTRAL_SETTINGS, ...JSON.parse(window.localStorage.getItem(MISTRAL_SETTINGS_KEY) || "{}") };
    } catch {
        return DEFAULT_MISTRAL_SETTINGS;
    }
}

function writeMistralSettings(settings) {
    window.localStorage.setItem(MISTRAL_SETTINGS_KEY, JSON.stringify(settings));
}

function friendlyFetchError(error, context) {
    const message = error?.message || String(error);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
        return `${context}: network/CORS failure. Deploy the Supabase Edge Function analyze-mistral, check VITE_SUPABASE_URL, or run the GitHub Action "Run Mistral Analysis".`;
    }
    return `${context}: ${message}`;
}

async function runMistralAnalysis(settings) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Supabase is not configured in the frontend environment.");
    let edgePayload = {};
    let edgeError = "";
    try {
        const edgeResponse = await fetch(`${SUPABASE_URL}/functions/v1/analyze-mistral`, {
            method: "POST",
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                productSlug: "spendesk",
                limit: 240,
                model: settings.model || DEFAULT_MISTRAL_SETTINGS.model,
                prompt: settings.prompt || DEFAULT_MISTRAL_SETTINGS.prompt,
                mistralApiKey: settings.apiKey || undefined,
            }),
        });
        edgePayload = await edgeResponse.json().catch(() => ({}));
        if (edgeResponse.ok && edgePayload.ok !== false) return { ...edgePayload, source: "supabase-edge" };
        edgeError = edgePayload.error || `Edge Function returned ${edgeResponse.status}`;
    } catch (err) {
        edgeError = friendlyFetchError(err, "Edge Function analyze-mistral");
    }
    if (!settings.apiKey) throw new Error(`${edgeError}. Add a Mistral API key in Settings or configure MISTRAL_API_KEY as a Supabase secret.`);

    const reviews = await fetchAllReviews();
    const sampledReviews = reviews.slice(0, 240);
    let insights;
    try {
        insights = await runMistralInBrowser(settings, sampledReviews);
    } catch (err) {
        throw new Error(`${edgeError}. Browser fallback failed too: ${friendlyFetchError(err, "Mistral browser call")}`);
    }
    const persisted = await saveBrowserInsights(settings, insights).catch(() => false);
    return {
        ok: true,
        source: persisted ? "browser-mistral-supabase" : "browser-mistral-local",
        productSlug: "spendesk",
        model: settings.model || DEFAULT_MISTRAL_SETTINGS.model,
        analyzed: sampledReviews.length,
        insights,
        persisted,
        edgeError,
    };
}

function compactReviewForAi(review) {
    const data = review.data || {};
    return {
        date: review.review_date_iso || review.review_date,
        rating: review.rating,
        title: review.title,
        summary: data.summary,
        pros: data.pros,
        cons: data.cons,
        role: data.reviewer_role,
        industry: data.reviewer_industry,
    };
}

function buildMistralMessages(settings, reviews) {
    const outputSchema = {
        keywords: [{ theme: "Clear semantic keyword, no typo", count: 12 }],
        top_pros: [{ title: "Theme name", description: "Concrete takeaway from reviews", count: 12, example: "Short paraphrased example" }],
        top_cons: [{ title: "Theme name", description: "Concrete takeaway from reviews", count: 8, example: "Short paraphrased example" }],
        categories: [{ category: "Overall Experience", score: 4.4, trend: "High", takeaway: "Strategic synthesis" }],
    };
    return [
        {
            role: "system",
            content: "You analyze SaaS product reviews. Return only valid JSON. Group related wording into coherent semantic themes. Do not output malformed tokens, misspellings, stop words, brand-only words, or generic words. Scores must be numeric between 0 and 5.",
        },
        {
            role: "user",
            content: JSON.stringify({
                task: "Create coherent analytics insights for Capterra reviews of spendesk.",
                analysis_instructions: settings.prompt || DEFAULT_MISTRAL_SETTINGS.prompt,
                output_schema: outputSchema,
                required_categories: ["Overall Experience", "Features", "Pricing", "Ease of Use"],
                reviews: reviews.map(compactReviewForAi),
            }),
        },
    ];
}

async function runMistralInBrowser(settings, reviews) {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: settings.model || DEFAULT_MISTRAL_SETTINGS.model,
            messages: buildMistralMessages(settings, reviews),
            temperature: 0.2,
            response_format: { type: "json_object" },
        }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error?.message || `Mistral browser call failed (${response.status})`);
    return JSON.parse(payload.choices?.[0]?.message?.content || "{}");
}

async function saveBrowserInsights(settings, insights) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${INSIGHTS_TABLE}?on_conflict=product_slug`, {
        method: "POST",
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify([{
            product_slug: "spendesk",
            model: settings.model || DEFAULT_MISTRAL_SETTINGS.model,
            generated_at: new Date().toISOString(),
            insights,
        }]),
    });
    return response.ok;
}

async function testMistralConnection(settings) {
    const model = settings.model || DEFAULT_MISTRAL_SETTINGS.model;
    let edgeError = "";
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
        try {
            const edgeResponse = await fetch(`${SUPABASE_URL}/functions/v1/analyze-mistral`, {
                method: "POST",
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ action: "test", model, mistralApiKey: settings.apiKey || undefined }),
            });
            const edgePayload = await edgeResponse.json().catch(() => ({}));
            if (edgeResponse.ok && edgePayload.ok !== false) return { ok: true, source: "Supabase Edge Function", model };
            edgeError = edgePayload.error || `Edge Function returned ${edgeResponse.status}`;
            if (!settings.apiKey) throw new Error(edgeError);
        } catch (err) {
            edgeError = friendlyFetchError(err, "Edge Function test");
            if (!settings.apiKey) throw new Error(edgeError);
        }
    }
    if (!settings.apiKey) throw new Error("Add a Mistral API key or configure MISTRAL_API_KEY in the Supabase Edge Function.");
    let response;
    try {
        response = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: "Return only valid JSON." },
                    { role: "user", content: '{"ok": true, "message": "Mistral connection test"}' },
                ],
                temperature: 0,
                response_format: { type: "json_object" },
            }),
        });
    } catch (err) {
        throw new Error(`${edgeError ? edgeError + ". " : ""}${friendlyFetchError(err, "Mistral browser test")}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${edgeError ? edgeError + ". " : ""}${payload.message || payload.error?.message || `Mistral test failed (${response.status})`}`);
    return { ok: true, source: "browser fallback", model };
}

async function runAiDiagnostics() {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    add("Supabase env", Boolean(SUPABASE_URL && SUPABASE_ANON_KEY), SUPABASE_URL ? new URL(SUPABASE_URL).host : "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return checks;

    try {
        const reviewsUrl = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`);
        reviewsUrl.searchParams.set("select", "fingerprint");
        reviewsUrl.searchParams.set("limit", "1");
        const response = await fetch(reviewsUrl, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
        add("Reviews table", response.ok, response.ok ? "Readable" : `${response.status}: ${(await response.text()).slice(0, 180)}`);
    } catch (err) {
        add("Reviews table", false, err.message || String(err));
    }

    try {
        const insightsUrl = new URL(`${SUPABASE_URL}/rest/v1/${INSIGHTS_TABLE}`);
        insightsUrl.searchParams.set("select", "product_slug");
        insightsUrl.searchParams.set("limit", "1");
        const response = await fetch(insightsUrl, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
        add("Insights table", response.ok, response.ok ? "Readable" : `${response.status}: ${(await response.text()).slice(0, 180)}`);
    } catch (err) {
        add("Insights table", false, err.message || String(err));
    }

    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/analyze-mistral`, {
            method: "OPTIONS",
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        });
        add("Edge Function", response.ok, response.ok ? "Reachable" : `${response.status}: deploy analyze-mistral or use browser fallback`);
    } catch (err) {
        add("Edge Function", false, friendlyFetchError(err, "analyze-mistral"));
    }
    return checks;
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

async function fetchAiInsights() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    const url = new URL(`${SUPABASE_URL}/rest/v1/${INSIGHTS_TABLE}`);
    url.searchParams.set("select", "insights,generated_at,model");
    url.searchParams.set("product_slug", "eq.spendesk");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!response.ok) return null;
    const rows = await response.json();
    return rows[0] || null;
}

const SEMANTIC_THEMES = [
    {
        id: "ease_of_use",
        label: "Ease of use",
        icon: "speed",
        type: "pro",
        category: "Ease of Use",
        terms: ["easy", "ease", "simple", "simplicite", "simplicity", "intuitive", "facile", "rapide", "quick", "fast", "ux", "user friendly", "ergonomic"],
        fallback: "Users repeatedly describe the product as simple, fast, and easy to adopt.",
    },
    {
        id: "virtual_cards",
        label: "Virtual cards",
        icon: "credit_card",
        type: "pro",
        category: "Features",
        terms: ["card", "cards", "virtual", "carte", "cartes", "payment card", "corporate card", "temporary card", "debit card"],
        fallback: "Virtual cards and spending controls are a strong recurring positive.",
    },
    {
        id: "expense_workflow",
        label: "Expense workflows",
        icon: "account_balance_wallet",
        type: "pro",
        category: "Features",
        terms: ["expense", "expenses", "spend", "spending", "approval", "approvals", "workflow", "note de frais", "notes de frais", "reimbursement", "budget"],
        fallback: "Finance workflows, approvals, and expense tracking are frequently praised.",
    },
    {
        id: "accounting_sync",
        label: "Accounting sync",
        icon: "integration_instructions",
        type: "pro",
        category: "Features",
        terms: ["accounting", "xero", "netsuite", "quickbooks", "sage", "sync", "integration", "integrations", "erp", "export", "bookkeeping", "compta"],
        fallback: "Accounting integrations and exports reduce manual finance work.",
    },
    {
        id: "visibility_reporting",
        label: "Visibility & reporting",
        icon: "query_stats",
        type: "pro",
        category: "Overall Experience",
        terms: ["visibility", "report", "reporting", "dashboard", "tracking", "overview", "monitor", "control", "analytics", "real time", "realtime"],
        fallback: "Teams value the visibility they gain over company spend.",
    },
    {
        id: "mobile_app",
        label: "Mobile app",
        icon: "smartphone",
        type: "pro",
        category: "Ease of Use",
        terms: ["mobile", "app", "application", "phone", "receipt", "scan", "ocr", "photo"],
        fallback: "The mobile app is often tied to faster receipt and expense capture.",
    },
    {
        id: "pricing",
        label: "Pricing concerns",
        icon: "euro",
        type: "con",
        category: "Pricing",
        terms: ["price", "pricing", "cost", "expensive", "fees", "fee", "subscription", "plan", "tarif", "prix", "cher", "expensif"],
        fallback: "The most coherent drawback is price sensitivity, especially for smaller teams.",
    },
    {
        id: "ocr_receipts",
        label: "Receipt capture issues",
        icon: "receipt_long",
        type: "con",
        category: "Features",
        terms: ["receipt", "receipts", "ocr", "scan", "scanning", "photo", "invoice", "facture", "justificatif", "capture"],
        fallback: "Some users mention friction around receipts, OCR, or invoice capture.",
    },
    {
        id: "workflow_limits",
        label: "Workflow rigidity",
        icon: "account_tree",
        type: "con",
        category: "Features",
        terms: ["limit", "limits", "limited", "rigid", "custom", "customize", "customization", "flexibility", "approval", "workflow", "rule", "rules"],
        fallback: "A recurring negative theme is limited customization in workflows or approval rules.",
    },
    {
        id: "support_response",
        label: "Support response",
        icon: "support_agent",
        type: "con",
        category: "Overall Experience",
        terms: ["support", "customer service", "response", "slow", "ticket", "help", "assistance", "bug", "issue", "problem"],
        fallback: "When sentiment drops, support response time and issue resolution often appear.",
    },
    {
        id: "sync_reliability",
        label: "Sync reliability",
        icon: "sync_problem",
        type: "con",
        category: "Features",
        terms: ["sync", "synchronization", "integration", "bug", "error", "missing", "delay", "crash", "reliable", "reliability"],
        fallback: "A smaller but meaningful theme concerns sync reliability and integration gaps.",
    },
];

function normalizeText(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’`]/g, "'")
        .toLowerCase();
}

function reviewSemanticText(review, field) {
    const data = review.data || {};
    const pieces = field
        ? [data[field]]
        : [review.title, data.summary, data.pros, data.cons, data.reviewer_role, data.reviewer_industry];
    return normalizeText(pieces.filter(Boolean).join(" "));
}

function scoreThemes(reviews, options = {}) {
    const { field = null, type = null } = options;
    return SEMANTIC_THEMES
        .filter((theme) => !type || theme.type === type)
        .map((theme) => {
            const matchedReviews = [];
            for (const review of reviews) {
                const text = reviewSemanticText(review, field);
                if (!text) continue;
                const matched = theme.terms.some((term) => text.includes(normalizeText(term)));
                if (matched) matchedReviews.push(review);
            }
            const sample = matchedReviews.find((review) => {
                const data = review.data || {};
                return data[field] || data.summary || review.title;
            });
            return { ...theme, count: matchedReviews.length, sample };
        })
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getKeywords(reviews) {
    const themes = scoreThemes(reviews).filter((theme) => theme.count > 0).slice(0, 12);
    return themes.map((theme) => ({ word: theme.label, count: theme.count }));
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

function aiItems(items, fallbackIcons) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.slice(0, 3).map((item, idx) => ({
        icon: item.icon || fallbackIcons[idx % fallbackIcons.length],
        title: item.title || item.label || item.theme || "Insight",
        desc: compactText(item.desc || item.description || item.takeaway || item.example, "Generated from Mistral semantic analysis."),
    }));
}

function aiKeywords(items) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.slice(0, 12).map((item) => ({
        word: item.theme || item.label || item.word || String(item),
        count: Number(item.count) || 1,
    }));
}

function aiCategoryRows(items) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.slice(0, 5).map((item) => {
        const scoreNumber = Number(item.score) || 0;
        const tone = scoreNumber >= 4 ? "positive" : scoreNumber >= 3 ? "neutral" : "negative";
        return {
            cat: item.category || item.cat || item.label || "Overall Experience",
            score: scoreNumber ? scoreNumber.toFixed(1) : "0.0",
            color: tone === "positive" ? "bg-secondary-fixed text-on-secondary-fixed" : tone === "neutral" ? "bg-surface-container text-on-surface-variant" : "bg-error-container text-on-error-container",
            trend: `${Math.max(6, Math.round((scoreNumber / 5) * 100))}%`,
            trendL: item.trend || (scoreNumber >= 4.6 ? "Peak" : scoreNumber >= 4 ? "High" : scoreNumber >= 3 ? "Mixed" : "Declining"),
            trendC: tone === "positive" ? "bg-on-tertiary-container" : tone === "neutral" ? "bg-outline" : "bg-error",
            quote: `"${compactText(item.takeaway || item.quote || item.summary, "No AI takeaway available.")}"`,
        };
    });
}

function InsightsProvider({ children }) {
    const [reviews, setReviews] = useState([]);
    const [aiInsights, setAiInsights] = useState(null);
    const [aiMeta, setAiMeta] = useState(null);
    const [aiRunning, setAiRunning] = useState(false);
    const [aiError, setAiError] = useState("");
    const [aiLastRun, setAiLastRun] = useState(null);
    const [newReviews, setNewReviews] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [ratingFilter, setRatingFilter] = useState("all");
    const [sentimentFilter, setSentimentFilter] = useState("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    useEffect(() => {
        let mounted = true;
        const refreshDashboardData = () => Promise.all([fetchAllReviews(), fetchAiInsights()])
            .then(([reviewRows, insightRows]) => {
                if (!mounted) return;
                setReviews(reviewRows);
                setAiInsights(insightRows?.insights || null);
                setAiMeta(insightRows ? { model: insightRows.model, generatedAt: insightRows.generated_at, source: "Supabase" } : null);
                setNewReviews(detectNewReviews(reviewRows));
            })
            .catch((err) => {
                if (mounted) setError(err.message || String(err));
            })
            .finally(() => {
                if (mounted) setLoading(false);
            });
        refreshDashboardData();
        const interval = window.setInterval(refreshDashboardData, 60000);
        return () => {
            mounted = false;
            window.clearInterval(interval);
        };
    }, []);
    const value = useMemo(() => {
        const datedReviews = reviews
            .map((review) => ({ review, date: parseReviewDate(review.review_date_iso || review.review_date || review.created_at) }))
            .filter((item) => !Number.isNaN(item.date.getTime()));
        const minDate = datedReviews.length ? new Date(Math.min(...datedReviews.map((item) => item.date.getTime()))) : null;
        const maxDate = datedReviews.length ? new Date(Math.max(...datedReviews.map((item) => item.date.getTime()))) : null;
        const fromDate = dateFrom ? parseReviewDate(dateFrom) : null;
        const toDate = dateTo ? parseReviewDate(dateTo) : null;
        if (toDate && !Number.isNaN(toDate.getTime())) {
            toDate.setHours(23, 59, 59, 999);
        }
        const q = query.trim().toLowerCase();
        const filtersActive = Boolean(q || ratingFilter !== "all" || sentimentFilter !== "all" || dateFrom || dateTo);
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
        const scrapeDates = reviews
            .map((review) => parseReviewDate(review.scraped_at || review.created_at))
            .filter((date) => !Number.isNaN(date.getTime()));
        const latestScrapeAt = scrapeDates.length ? new Date(Math.max(...scrapeDates.map((date) => date.getTime()))) : null;
        const keywords = !filtersActive && aiInsights ? (aiKeywords(aiInsights.keywords).length ? aiKeywords(aiInsights.keywords) : getKeywords(filteredReviews)) : getKeywords(filteredReviews);
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
            newReviews,
            aiRunning,
            aiError,
            aiLastRun,
            aiMeta,
            runAiAnalysis: async (settings) => {
                setAiRunning(true);
                setAiError("");
                try {
                    const payload = await runMistralAnalysis(settings);
                    setAiInsights(payload.insights || null);
                    setAiLastRun({ analyzed: payload.analyzed, model: payload.model, at: new Date(), source: payload.source, persisted: payload.persisted });
                    setAiMeta({ model: payload.model, generatedAt: new Date().toISOString(), source: payload.source || "Runtime" });
                    return payload;
                } catch (err) {
                    const message = err.message || String(err);
                    setAiError(message);
                    throw err;
                } finally {
                    setAiRunning(false);
                }
            },
            markNotificationsSeen: () => {
                writeSeenReviewIds(reviews);
                setNewReviews([]);
            },
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
            topPros: !filtersActive && aiInsights ? (aiItems(aiInsights.top_pros, ["speed", "credit_card", "integration_instructions"]).length ? aiItems(aiInsights.top_pros, ["speed", "credit_card", "integration_instructions"]) : buildHighlights(filteredReviews, "pros", fallbackPros)) : buildHighlights(filteredReviews, "pros", fallbackPros),
            topCons: !filtersActive && aiInsights ? (aiItems(aiInsights.top_cons, ["euro", "receipt_long", "sync_problem"]).length ? aiItems(aiInsights.top_cons, ["euro", "receipt_long", "sync_problem"]) : buildHighlights(filteredReviews, "cons", fallbackCons)) : buildHighlights(filteredReviews, "cons", fallbackCons),
            categoryRows: !filtersActive && aiInsights ? (aiCategoryRows(aiInsights.categories).length ? aiCategoryRows(aiInsights.categories) : buildCategoryRows(filteredReviews)) : buildCategoryRows(filteredReviews),
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
                latestScrapeAt,
                latestScrapeLabel: formatDateTime(latestScrapeAt),
            },
        };
    }, [reviews, aiInsights, aiMeta, aiRunning, aiError, aiLastRun, newReviews, loading, error, query, ratingFilter, sentimentFilter, dateFrom, dateTo]);
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
    const type = field === "pros" ? "pro" : "con";
    const source = scoreThemes(reviews, { field, type }).filter((theme) => theme.count > 0).slice(0, 3);
    if (!source.length) return fallbackItems;
    return source.map((theme) => ({
        icon: theme.icon,
        title: `${theme.label} (${theme.count} mentions)`,
        desc: compactText(theme.sample?.data?.[field] || theme.sample?.data?.summary || theme.sample?.title, theme.fallback),
    }));
}

function buildCategoryRows(reviews) {
    const specs = [
        { cat: "Overall Experience", words: [], quote: '"Overall sentiment is driven by ease of use, control, and reliable finance workflows."' },
        { cat: "Features", words: ["feature", "features", "card", "virtual", "workflow", "approval", "expense", "integration"], quote: '"Virtual cards and automated approvals are top tier."' },
        { cat: "Pricing", words: ["price", "pricing", "cost", "expensive", "plan", "value", "money"], quote: '"Value is high, but entry price is steep for SMBs."' },
        { cat: "Ease of Use", words: ["easy", "simple", "intuitive", "facile", "ux", "quick", "fast"], quote: '"Incredibly intuitive UX, almost zero learning curve."' },
    ];
    return specs.map((spec) => {
        const matched = spec.words.length ? reviews.filter((review) => spec.words.some((word) => reviewText(review).includes(word))) : reviews;
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
        { path: 'reviews', label: 'Reviews', icon: 'forum' },
        { path: 'settings', label: 'Settings', icon: 'settings' }
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
            const { query, setQuery, newReviews, markNotificationsSeen } = useInsights();
            const [open, setOpen] = useState(false);
            const notificationCards = newReviews.map((review, idx) => reviewToCard(review, idx));
            return (
                <header className="fixed top-0 right-0 left-64 h-20 z-40 bg-surface/80 backdrop-blur-md flex justify-between items-center px-lg">
                    <div className="flex items-center flex-1 max-w-xl">
                        <div className="relative w-full">
                            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
                            <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full bg-surface-container-low border-none rounded-full pl-12 pr-6 py-2.5 text-label-md focus:ring-2 focus:ring-secondary/20 transition-all" placeholder={title} type="text"/>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setOpen((current) => !current)}
                                className="relative w-10 h-10 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-all"
                                aria-label="Open notifications"
                            >
                                <span className="material-symbols-outlined" style={{fontVariationSettings: newReviews.length ? "'FILL' 1" : ""}}>notifications</span>
                                {newReviews.length > 0 && (
                                    <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 bg-error text-white text-[10px] font-extrabold rounded-full border-2 border-surface flex items-center justify-center">
                                        {newReviews.length}
                                    </span>
                                )}
                            </button>
                            {open && (
                                <div className="absolute right-0 top-12 w-96 max-w-[calc(100vw-2rem)] bg-surface-container-lowest border border-outline-variant/40 rounded-2xl shadow-xl p-4 z-50">
                                    <div className="flex items-start justify-between gap-4 mb-4">
                                        <div>
                                            <p className="font-extrabold text-primary text-body-lg">Notifications</p>
                                            <p className="text-label-sm text-on-surface-variant">
                                                {newReviews.length ? `${newReviews.length} new review${newReviews.length > 1 ? "s" : ""} detected` : "Nothing new for now"}
                                            </p>
                                        </div>
                                        {newReviews.length > 0 && (
                                            <button type="button" onClick={markNotificationsSeen} className="text-label-sm font-bold text-secondary hover:text-primary transition-colors">Mark read</button>
                                        )}
                                    </div>
                                    {notificationCards.length ? (
                                        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                                            {notificationCards.map((review, idx) => (
                                                <div key={idx} className="rounded-xl bg-surface-container-low p-4 border border-outline-variant/20">
                                                    <div className="flex items-center justify-between gap-3 mb-2">
                                                        <p className="font-bold text-primary text-label-md truncate">{review.name}</p>
                                                        <span className="text-[10px] font-extrabold text-on-tertiary-container bg-tertiary-fixed-dim/30 px-2 py-1 rounded-full uppercase">{review.sentiment}</span>
                                                    </div>
                                                    <p className="text-body-sm text-on-surface-variant line-clamp-2">{review.verdict}</p>
                                                    <div className="mt-3 flex items-center justify-between text-[11px] text-on-surface-variant">
                                                        <span>{review.date}</span>
                                                        <span className="text-secondary font-bold">{review.rating}/5</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="rounded-xl bg-surface-container-low p-6 text-center border border-outline-variant/20">
                                            <span className="material-symbols-outlined text-3xl text-secondary mb-2">notifications_paused</span>
                                            <p className="font-bold text-primary">No new reviews</p>
                                            <p className="text-label-sm text-on-surface-variant mt-1">The latest scrape is already reflected in the dashboard.</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
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
                                        <p className="text-secondary-fixed/70 text-[11px] font-bold mt-3 uppercase tracking-wider">Last scrape: {analytics.latestScrapeLabel}</p>
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
            const [sortMode, setSortMode] = useState("newest");
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
            const sortedReviews = [...filteredReviews].sort((a, b) => {
                const dateA = parseReviewDate(a.review_date_iso || a.review_date || a.created_at).getTime();
                const dateB = parseReviewDate(b.review_date_iso || b.review_date || b.created_at).getTime();
                const ratingA = asNumber(a.rating) || 0;
                const ratingB = asNumber(b.rating) || 0;
                if (sortMode === "oldest") return (Number.isNaN(dateA) ? Infinity : dateA) - (Number.isNaN(dateB) ? Infinity : dateB);
                if (sortMode === "rating-high") return ratingB - ratingA;
                if (sortMode === "rating-low") return ratingA - ratingB;
                return (Number.isNaN(dateB) ? -Infinity : dateB) - (Number.isNaN(dateA) ? -Infinity : dateA);
            });
            const cards = sortedReviews.slice(0, 50).map(reviewToCard);
            return (
                <div className="animate-fade-in flex flex-col h-screen">
                    <TopBar title="Search reviews..." />
                    <main className="ml-64 pt-20 flex flex-1 overflow-hidden">
                        <section className="flex-1 overflow-y-auto px-container-padding py-10 bg-background">
                            <div className="max-w-4xl mx-auto space-y-8">
                                <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 mb-10">
                                    <div>
                                        <span className="text-[10px] font-bold text-on-tertiary-container bg-tertiary-fixed-dim/30 px-3 py-1 rounded-full uppercase tracking-[0.15em] mb-3 inline-block">Extracting: Spendesk</span>
                                        <h2 className="text-headline-lg font-bold text-primary tracking-tight">Review Feed</h2>
                                        <p className="text-on-surface-variant font-body-md mt-1 opacity-80">Latest verified feedback from Capterra users.</p>
                                    </div>
                                    <div className="flex flex-wrap justify-end gap-3">
                                        <label className="flex items-center gap-2 px-4 py-2.5 bg-surface-container-lowest border border-outline-variant/30 rounded-lg shadow-sm">
                                            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">sort</span>
                                            <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} className="bg-transparent border-none text-label-md font-bold text-primary focus:ring-0 p-0">
                                                <option value="newest">Newest first</option>
                                                <option value="oldest">Oldest first</option>
                                                <option value="rating-high">Highest rating</option>
                                                <option value="rating-low">Lowest rating</option>
                                            </select>
                                        </label>
                                        <label className="flex items-center gap-2 px-4 py-2.5 bg-surface-container-lowest border border-outline-variant/30 rounded-lg shadow-sm">
                                            <span className="material-symbols-outlined text-[18px] text-secondary" style={{fontVariationSettings: "'FILL' 1"}}>star</span>
                                            <select value={ratingFilter} onChange={(event) => setRatingFilter(event.target.value)} className="bg-transparent border-none text-label-md font-bold text-primary focus:ring-0 p-0">
                                                <option value="all">All ratings</option>
                                                <option value="5">5 stars</option>
                                                <option value="4">4 stars</option>
                                                <option value="3">3 stars</option>
                                                <option value="2">2 stars</option>
                                                <option value="1">1 star</option>
                                            </select>
                                        </label>
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
                                                    <div className="flex items-center justify-end gap-0.5 mb-2" aria-label={`${review.rating} out of 5 stars`}>
                                                        {[1,2,3,4,5].map(s => <span key={s} className={`text-xl leading-none ${s <= review.rating ? "text-secondary" : "text-outline-variant/40"}`}>★</span>)}
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
                                    <p className="text-[11px] text-on-surface-variant font-bold mt-3 uppercase tracking-wider">Last scrape: {analytics.latestScrapeLabel}</p>
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

        const SentimentPage = ({ setActivePage }) => {
            const { analytics, keywords, categoryRows, aiMeta, setQuery, setSentimentFilter, setRatingFilter } = useInsights();
            const openReviewsBySentiment = (sentiment) => {
                setQuery("");
                setRatingFilter("all");
                setSentimentFilter(sentiment);
                setActivePage("reviews");
            };
            const openReviewsByKeyword = (keyword) => {
                setQuery(keyword);
                setRatingFilter("all");
                setSentimentFilter("all");
                setActivePage("reviews");
            };
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
                                <div className={`hidden md:flex items-center gap-3 px-5 py-3 rounded-full border ${aiMeta ? "bg-secondary/10 border-secondary/20 text-secondary" : "bg-surface-container-low border-outline-variant/30 text-on-surface-variant"}`}>
                                    <span className="material-symbols-outlined text-[20px]">{aiMeta ? "auto_awesome" : "schema"}</span>
                                    <div className="text-left">
                                        <p className="text-[10px] uppercase tracking-widest font-extrabold">{aiMeta ? "Mistral active" : "Local synthesis"}</p>
                                        <p className="text-[11px] font-bold">{aiMeta ? `${aiMeta.model || "model"} - ${formatDateTime(aiMeta.generatedAt)}` : "No AI insights saved yet"}</p>
                                    </div>
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
                                        <button type="button" onClick={() => openReviewsBySentiment("Positive")} className="text-center p-3 rounded-2xl bg-on-tertiary-container/5 hover:bg-on-tertiary-container/10 transition-all cursor-pointer">
                                            <p className="text-on-tertiary-container font-bold text-lg">{analytics.scopedPositivePctLabel}</p>
                                            <p className="font-label-md text-on-surface-variant">Positive</p>
                                        </button>
                                        <button type="button" onClick={() => openReviewsBySentiment("Neutral")} className="text-center p-3 rounded-2xl bg-secondary/5 hover:bg-secondary/10 transition-all cursor-pointer">
                                            <p className="text-secondary font-bold text-lg">{analytics.scopedNeutralPct}%</p>
                                            <p className="font-label-md text-on-surface-variant">Neutral</p>
                                        </button>
                                        <button type="button" onClick={() => openReviewsBySentiment("Negative")} className="text-center p-3 rounded-2xl bg-error/5 hover:bg-error/10 transition-all cursor-pointer">
                                            <p className="text-error font-bold text-lg">{analytics.scopedNegativePctLabel}</p>
                                            <p className="font-label-md text-on-surface-variant">Negative</p>
                                        </button>
                                    </div>
                                </div>

                                <div className="col-span-12 lg:col-span-7 bg-surface-container-lowest border border-outline-variant/50 p-8 rounded-lg shadow-sm hover:shadow-md transition-all">
                                    <h3 className="font-label-md uppercase tracking-widest text-on-surface-variant mb-8">Voice of Customer Keywords</h3>
                                    <div className="flex flex-wrap gap-4 h-[320px] content-start">
                                        {keywordTags.map((tag, idx) => (
                                            <button key={idx} type="button" onClick={() => openReviewsByKeyword(tag.t)} className={`${tag.c} ${tag.s} rounded-xl cursor-pointer hover:scale-105 transition-all shadow-sm text-left`}>{tag.t}</button>
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

        const SettingsPage = () => {
            const { aiRunning, aiError, aiLastRun, aiMeta, runAiAnalysis } = useInsights();
            const [settings, setSettings] = useState(readMistralSettings);
            const [saved, setSaved] = useState(false);
            const [showKey, setShowKey] = useState(false);
            const [runResult, setRunResult] = useState("");
            const [testRunning, setTestRunning] = useState(false);
            const [testResult, setTestResult] = useState("");
            const [testError, setTestError] = useState("");
            const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
            const [diagnostics, setDiagnostics] = useState([]);
            const maskedKey = settings.apiKey ? `${settings.apiKey.slice(0, 10)}${"•".repeat(Math.max(0, Math.min(18, settings.apiKey.length - 10)))}` : "No key saved";
            const command = [
                '$env:SUPABASE_URL="https://xxxx.supabase.co"',
                '$env:SUPABASE_SERVICE_ROLE_KEY="..."',
                `$env:MISTRAL_API_KEY="${settings.apiKey || "..."}"`,
                `$env:MISTRAL_MODEL="${settings.model || DEFAULT_MISTRAL_SETTINGS.model}"`,
                `$env:MISTRAL_REVIEW_PROMPT=@'\n${settings.prompt || DEFAULT_MISTRAL_SETTINGS.prompt}\n'@`,
                "python analyze_reviews_mistral.py --product-slug spendesk",
            ].join("\n");
            const updateSetting = (key, value) => {
                setSaved(false);
                setSettings((current) => ({ ...current, [key]: value }));
            };
            const saveSettings = () => {
                writeMistralSettings(settings);
                setSaved(true);
            };
            const startAnalysis = async () => {
                saveSettings();
                setRunResult("");
                try {
                    const payload = await runAiAnalysis(settings);
                    const sourceLabel = payload.source === "supabase-edge" ? "Supabase Edge Function" : "browser fallback";
                    const persistenceLabel = payload.persisted === false ? "Displayed locally; Supabase persistence was not allowed." : "Insights saved to Supabase.";
                    setRunResult(`${payload.analyzed} reviews analyzed with ${payload.model} via ${sourceLabel}. ${persistenceLabel}`);
                } catch (err) {
                    setRunResult("");
                }
            };
            const startConnectionTest = async () => {
                saveSettings();
                setTestRunning(true);
                setTestResult("");
                setTestError("");
                try {
                    const payload = await testMistralConnection(settings);
                    setTestResult(`Connection OK via ${payload.source} using ${payload.model}.`);
                } catch (err) {
                    setTestError(err.message || String(err));
                } finally {
                    setTestRunning(false);
                }
            };
            const startDiagnostics = async () => {
                setDiagnosticsRunning(true);
                try {
                    setDiagnostics(await runAiDiagnostics());
                } finally {
                    setDiagnosticsRunning(false);
                }
            };
            const resetSettings = () => {
                setSettings(DEFAULT_MISTRAL_SETTINGS);
                writeMistralSettings(DEFAULT_MISTRAL_SETTINGS);
                setSaved(true);
            };
            const copyCommand = () => {
                navigator.clipboard?.writeText(command);
                setSaved(true);
            };
            return (
                <div className="animate-fade-in">
                    <TopBar title="Search settings..." />
                    <main className="ml-64 pt-28 pb-16 px-lg">
                        <div className="max-w-[1180px] mx-auto space-y-8">
                            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                                <div>
                                    <h2 className="text-display font-bold text-primary mb-2">Settings</h2>
                                    <p className="text-body-md text-on-surface-variant max-w-2xl">Configure the Mistral analysis layer used to turn raw reviews into coherent themes, keywords, pros, cons, and categorized performance.</p>
                                </div>
                                <div className={`px-4 py-2 rounded-full text-label-md font-bold ${saved ? "bg-tertiary-fixed text-on-tertiary-container" : "bg-surface-container text-on-surface-variant"}`}>
                                    {saved ? "Saved locally" : "Local settings"}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                                <section className="xl:col-span-2 bg-surface-container-lowest border border-outline-variant/40 rounded-lg p-8 shadow-sm">
                                    <div className="flex items-start gap-4 mb-8">
                                        <div className="w-12 h-12 rounded-xl bg-secondary/10 text-secondary flex items-center justify-center">
                                            <span className="material-symbols-outlined">auto_awesome</span>
                                        </div>
                                        <div>
                                            <h3 className="text-headline-md font-extrabold text-primary">Mistral AI</h3>
                                            <p className="text-body-md text-on-surface-variant">Store your API key, model, and prompt template for the review analysis job.</p>
                                        </div>
                                    </div>

                                    <div className="space-y-6">
                                        <div>
                                            <label className="block text-[10px] uppercase tracking-[0.15em] font-extrabold text-on-surface-variant mb-3">API Key</label>
                                            <div className="flex gap-3">
                                                <input
                                                    value={settings.apiKey}
                                                    onChange={(event) => updateSetting("apiKey", event.target.value)}
                                                    className="flex-1 bg-surface-container-low border-none rounded-xl px-4 py-3 text-label-md focus:ring-2 focus:ring-secondary/20"
                                                    placeholder="mistral api key"
                                                    type={showKey ? "text" : "password"}
                                                />
                                                <button type="button" onClick={() => setShowKey((current) => !current)} className="w-12 h-12 rounded-xl bg-surface-container-low text-on-surface-variant hover:text-secondary transition-colors flex items-center justify-center">
                                                    <span className="material-symbols-outlined">{showKey ? "visibility_off" : "visibility"}</span>
                                                </button>
                                            </div>
                                            <p className="text-[11px] text-on-surface-variant mt-2">Saved in this browser only. Do not put this key in the public frontend env.</p>
                                        </div>

                                        <div>
                                            <label className="block text-[10px] uppercase tracking-[0.15em] font-extrabold text-on-surface-variant mb-3">Model</label>
                                            <input
                                                value={settings.model}
                                                onChange={(event) => updateSetting("model", event.target.value)}
                                                className="w-full bg-surface-container-low border-none rounded-xl px-4 py-3 text-label-md focus:ring-2 focus:ring-secondary/20"
                                                placeholder="mistral-small-latest"
                                                list="mistral-models"
                                            />
                                            <datalist id="mistral-models">
                                                <option value="mistral-small-latest" />
                                                <option value="mistral-medium-latest" />
                                                <option value="mistral-large-latest" />
                                            </datalist>
                                        </div>

                                        <div>
                                            <label className="block text-[10px] uppercase tracking-[0.15em] font-extrabold text-on-surface-variant mb-3">AI Prompt</label>
                                            <textarea
                                                value={settings.prompt}
                                                onChange={(event) => updateSetting("prompt", event.target.value)}
                                                className="w-full min-h-56 bg-surface-container-low border-none rounded-xl px-4 py-4 text-body-md leading-relaxed focus:ring-2 focus:ring-secondary/20"
                                                placeholder="Tell Mistral how to group reviews..."
                                            />
                                        </div>

                                        <div className="flex flex-wrap gap-3 pt-2">
                                            <button type="button" onClick={saveSettings} className="px-6 py-3 bg-secondary text-on-secondary rounded-xl font-label-md shadow-sm hover:bg-secondary-container transition-all">Save settings</button>
                                            <button type="button" onClick={startConnectionTest} disabled={testRunning || aiRunning} className="px-6 py-3 bg-surface-container-low text-primary rounded-xl font-label-md hover:bg-surface-container transition-all disabled:opacity-60 disabled:cursor-not-allowed">
                                                {testRunning ? "Testing..." : "Test connection"}
                                            </button>
                                            <button type="button" onClick={startAnalysis} disabled={aiRunning} className="px-6 py-3 bg-primary text-on-primary rounded-xl font-label-md shadow-sm hover:bg-secondary transition-all disabled:opacity-60 disabled:cursor-not-allowed">
                                                {aiRunning ? "Running analysis..." : "Run Mistral analysis"}
                                            </button>
                                            <button type="button" onClick={resetSettings} className="px-6 py-3 bg-surface-container-low text-primary rounded-xl font-label-md hover:bg-surface-container transition-all">Reset</button>
                                        </div>
                                        {(testResult || testError) && (
                                            <div className={`rounded-xl p-4 border ${testError ? "bg-error-container/20 border-error-container text-error" : "bg-secondary/10 border-secondary/20 text-secondary"}`}>
                                                <p className="font-bold text-label-md">{testError ? "Connection failed" : "Connection verified"}</p>
                                                <p className="text-body-sm mt-1">{testError || testResult}</p>
                                            </div>
                                        )}
                                        {(runResult || aiError || aiLastRun) && (
                                            <div className={`rounded-xl p-4 border ${aiError ? "bg-error-container/20 border-error-container text-error" : "bg-tertiary-fixed/20 border-tertiary-fixed/40 text-on-tertiary-container"}`}>
                                                <p className="font-bold text-label-md">{aiError ? "Analysis failed" : "Analysis ready"}</p>
                                                <p className="text-body-sm mt-1">
                                                    {aiError || runResult || `${aiLastRun?.analyzed || 0} reviews analyzed with ${aiLastRun?.model || settings.model}.`}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                </section>

                                <aside className="space-y-6">
                                    <div className="bg-primary text-on-primary rounded-lg p-6 shadow-sm">
                                        <div className="flex items-center justify-between mb-6">
                                            <span className="text-[10px] uppercase tracking-[0.15em] font-extrabold opacity-70">Current AI Config</span>
                                            <span className="material-symbols-outlined">lock</span>
                                        </div>
                                        <div className="space-y-4">
                                            <div>
                                                <p className="text-[10px] uppercase tracking-widest opacity-60 font-bold">Key</p>
                                                <p className="font-label-md break-all">{maskedKey}</p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-widest opacity-60 font-bold">Model</p>
                                                <p className="font-label-md">{settings.model || DEFAULT_MISTRAL_SETTINGS.model}</p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-widest opacity-60 font-bold">Loaded insights</p>
                                                <p className="font-label-md">{aiMeta ? `${aiMeta.model || "model"} - ${formatDateTime(aiMeta.generatedAt)}` : "No saved AI insights loaded"}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-surface-container-lowest border border-outline-variant/40 rounded-lg p-6 shadow-sm">
                                        <div className="flex items-start justify-between gap-4 mb-4">
                                            <div>
                                                <h3 className="text-headline-sm font-extrabold text-primary mb-2">AI diagnostics</h3>
                                                <p className="text-body-sm text-on-surface-variant">Check Supabase tables and Edge Function reachability before running the full analysis.</p>
                                            </div>
                                            <button type="button" onClick={startDiagnostics} disabled={diagnosticsRunning} className="px-4 py-2 rounded-xl bg-surface-container-low text-primary font-label-md hover:bg-surface-container transition-all disabled:opacity-60">
                                                {diagnosticsRunning ? "Checking" : "Run"}
                                            </button>
                                        </div>
                                        <div className="space-y-2">
                                            {(diagnostics.length ? diagnostics : [
                                                { name: "Supabase env", ok: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY), detail: SUPABASE_URL ? new URL(SUPABASE_URL).host : "Not checked yet" },
                                                { name: "Reviews table", ok: null, detail: "Run diagnostics" },
                                                { name: "Insights table", ok: null, detail: "Run diagnostics" },
                                                { name: "Edge Function", ok: null, detail: "Run diagnostics" },
                                            ]).map((check) => (
                                                <div key={check.name} className="flex items-center justify-between gap-3 rounded-xl bg-surface-container-low px-4 py-3">
                                                    <div>
                                                        <p className="font-bold text-label-md text-primary">{check.name}</p>
                                                        <p className="text-[11px] text-on-surface-variant break-all">{check.detail}</p>
                                                    </div>
                                                    <span className={`material-symbols-outlined ${check.ok === true ? "text-secondary" : check.ok === false ? "text-error" : "text-outline"}`}>
                                                        {check.ok === true ? "check_circle" : check.ok === false ? "error" : "radio_button_unchecked"}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="bg-surface-container-lowest border border-outline-variant/40 rounded-lg p-6 shadow-sm">
                                        <h3 className="text-headline-sm font-extrabold text-primary mb-2">Run command</h3>
                                        <p className="text-body-sm text-on-surface-variant mb-4">Use this locally or in a secure job. The browser should not call Mistral directly.</p>
                                        <pre className="bg-surface-container-low rounded-xl p-4 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-on-surface-variant">{command}</pre>
                                        <button type="button" onClick={copyCommand} className="mt-4 w-full py-3 bg-secondary text-on-secondary rounded-xl font-label-md hover:bg-secondary-container transition-all">Copy command</button>
                                    </div>
                                </aside>
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
                    {activePage === 'settings' ? <SettingsPage /> : activePage === 'reviews' ? <ReviewsPage /> : activePage === 'sentiment' ? <SentimentPage setActivePage={setActivePage} /> : <OverviewPage />}
                </div>
            </div>
        </InsightsProvider>
    );
};

createRoot(document.getElementById('root')).render(<App />);

