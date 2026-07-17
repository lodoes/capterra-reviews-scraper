const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REVIEWS_TABLE = Deno.env.get("SUPABASE_TABLE") || "capterra_reviews";
const INSIGHTS_TABLE = Deno.env.get("SUPABASE_INSIGHTS_TABLE") || "capterra_review_insights";
const DEFAULT_MODEL = Deno.env.get("MISTRAL_MODEL") || "mistral-small-latest";
const DEFAULT_PROMPT = Deno.env.get("MISTRAL_REVIEW_PROMPT") ||
  "Group Capterra reviews into coherent business themes. Return clean keywords, top pros, top cons, and categorized performance with an overall synthesis. Avoid malformed words, raw stop words, generic brand-only terms, and vague labels.";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function compactReview(review: Record<string, any>) {
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

function buildMessages(productSlug: string, reviews: Record<string, any>[], prompt: string) {
  const outputSchema = {
    keywords: [{ theme: "Clear semantic keyword, no typo", count: 12 }],
    top_pros: [{ title: "Theme name", description: "Concrete takeaway from reviews", count: 12, example: "Short paraphrased example" }],
    top_cons: [{ title: "Theme name", description: "Concrete takeaway from reviews", count: 8, example: "Short paraphrased example" }],
    categories: [{ category: "Overall Experience", score: 4.4, trend: "High", takeaway: "Strategic synthesis" }],
  };
  return [
    {
      role: "system",
      content:
        "You analyze SaaS product reviews. Return only valid JSON. Group related wording into coherent semantic themes. Do not output malformed tokens, misspellings, stop words, brand-only words, or generic words. Scores must be numeric between 0 and 5.",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: `Create coherent analytics insights for Capterra reviews of ${productSlug}.`,
        analysis_instructions: prompt,
        output_schema: outputSchema,
        required_categories: ["Overall Experience", "Features", "Pricing", "Ease of Use"],
        reviews: reviews.map(compactReview),
      }),
    },
  ];
}

async function fetchReviews(supabaseUrl: string, serviceKey: string, productSlug: string, limit: number) {
  const url = new URL(`${supabaseUrl}/rest/v1/${REVIEWS_TABLE}`);
  url.searchParams.set("select", "review_date_iso,review_date,reviewer,title,rating,data,created_at");
  url.searchParams.set("product_slug", `eq.${productSlug}`);
  url.searchParams.set("order", "review_date_iso.desc.nullslast,created_at.desc");
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new Error(`Supabase read ${response.status}: ${await response.text()}`);
  return await response.json();
}

async function callMistral(apiKey: string, model: string, messages: Record<string, string>[]) {
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`Mistral ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content || "{}");
}

async function saveInsights(supabaseUrl: string, serviceKey: string, productSlug: string, model: string, insights: Record<string, any>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${INSIGHTS_TABLE}?on_conflict=product_slug`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{
      product_slug: productSlug,
      model,
      generated_at: new Date().toISOString(),
      insights,
    }]),
  });
  if (!response.ok) throw new Error(`Supabase write ${response.status}: ${await response.text()}`);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const productSlug = String(body.productSlug || "spendesk");
    const limit = Math.min(Math.max(Number(body.limit) || 240, 25), 500);
    const model = String(body.model || DEFAULT_MODEL);
    const prompt = String(body.prompt || DEFAULT_PROMPT);
    const mistralApiKey = String(body.mistralApiKey || Deno.env.get("MISTRAL_API_KEY") || "").trim();
    if (!mistralApiKey) throw new Error("Missing Mistral API key. Send one from Settings or configure MISTRAL_API_KEY as a Supabase secret.");

    if (body.action === "test") {
      const testInsights = await callMistral(mistralApiKey, model, [
        { role: "system", content: "Return only valid JSON." },
        { role: "user", content: '{"ok": true, "message": "Mistral connection test"}' },
      ]);
      return jsonResponse({ ok: true, model, test: testInsights });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret.");

    const reviews = await fetchReviews(supabaseUrl, serviceKey, productSlug, limit);
    if (!reviews.length) throw new Error(`No reviews found for product_slug=${productSlug}.`);

    const insights = await callMistral(mistralApiKey, model, buildMessages(productSlug, reviews, prompt));
    await saveInsights(supabaseUrl, serviceKey, productSlug, model, insights);

    return jsonResponse({ ok: true, productSlug, model, analyzed: reviews.length, insights });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
