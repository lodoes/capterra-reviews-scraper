create table if not exists public.capterra_reviews (
  fingerprint text primary key,
  product_slug text not null,
  source_url text not null,
  review_date text,
  review_date_iso date,
  reviewer text,
  title text,
  rating text,
  page integer,
  scraped_at timestamptz,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists capterra_reviews_product_slug_idx
  on public.capterra_reviews (product_slug);

create index if not exists capterra_reviews_review_date_idx
  on public.capterra_reviews (review_date);

alter table public.capterra_reviews
  add column if not exists review_date_iso date;

create index if not exists capterra_reviews_review_date_iso_idx
  on public.capterra_reviews (review_date_iso);

create index if not exists capterra_reviews_data_gin_idx
  on public.capterra_reviews using gin (data);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_capterra_reviews_updated_at on public.capterra_reviews;

create trigger set_capterra_reviews_updated_at
before update on public.capterra_reviews
for each row
execute function public.set_updated_at();

alter table public.capterra_reviews enable row level security;

drop policy if exists "Public read capterra reviews" on public.capterra_reviews;

create policy "Public read capterra reviews"
on public.capterra_reviews
for select
to anon
using (true);

grant usage on schema public to anon;
grant select on public.capterra_reviews to anon;
