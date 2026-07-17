# Spendesk Capterra Analytics

Projet realise pour le cas pratique Skello : scraper les reviews Spendesk sur Capterra sans actor pre-build, stocker les donnees dans une base, puis les afficher dans un front analytics public.

## Ce que contient le projet

- `capterra_scraper.py` : scraper Python base sur SeleniumBase UC/CDP.
- `supabase_schema.sql` : schema Supabase pour les reviews et les insights IA.
- `frontend/` : dashboard React public.
- `analyze_reviews_mistral.py` : enrichissement IA cote serveur/local.
- `.github/workflows/` : workflows pour scraper, lancer l'analyse IA et deployer la Supabase Edge Function.

## Demarche

J'ai commence par tester Web Scraper et Instant Data Scraper pour comprendre la structure des pages Capterra. Je suis ensuite passe sur une implementation full Python pour respecter la consigne et controler toute la logique d'extraction.

La difficulte principale a ete le contournement des protections Capterra : erreurs 403, puis Cloudflare. La version actuelle utilise SeleniumBase en mode UC/CDP, ce qui fonctionne en local et permet d'extraire les avis avec davantage de contexte.

Les reviews sont ensuite stockees dans Supabase, puis consommees par un dashboard React. Une couche IA avec Mistral peut regrouper les keywords, nettoyer les termes peu utiles, deduire les pros/cons et produire une synthese plus lisible.

## Donnees extraites

Le scraper recupere notamment :

- reviewer
- date de review + date ISO exploitable
- titre et summary
- rating global
- pros et cons
- role, industrie, taille d'entreprise quand disponible
- reponse editeur quand disponible
- source URL
- payload complet dans une colonne JSONB

Chaque avis est upsert dans Supabase avec un `fingerprint` unique pour eviter les doublons.

## Lancer le scraper en local

Installation :

```powershell
pip install -r requirements.txt
```

Scrape simple :

```powershell
python capterra_scraper.py --headless
```

Scrape + upload Supabase :

```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="..."
python capterra_scraper.py --headless --supabase
```

Limiter les pages pour tester :

```powershell
python capterra_scraper.py --headless --max-pages 2
```

Les exports CSV/JSON sont generes dans `resultats/`.

## Supabase

1. Executer `supabase_schema.sql` dans le SQL Editor Supabase.
2. Configurer `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` cote serveur/local/GitHub Actions.
3. Le front utilise uniquement la cle anon publique, jamais la service role key.

Tables principales :

- `capterra_reviews`
- `capterra_review_insights`

## Front analytics

Le front se trouve dans `frontend/`.

```powershell
cd frontend
npm install
npm run dev
```

Fonctionnalites principales :

- overview
- sentiment analysis
- review feed avec recherche, tri et filtres
- filtres date/rating/sentiment
- notifications de nouveaux avis
- settings oriente utilisateur
- lecture des insights IA sauvegardes en base

Pour Render, utiliser un **Static Site** :

- Root Directory: `frontend`
- Build Command: `npm install && npm run build`
- Publish Directory: `dist`

Variables front minimales :

```text
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

## IA Mistral

L'IA n'est pas appelee directement depuis le navigateur. Elle sert a produire des insights plus propres que de simples comptages de mots :

- keywords regroupes par themes
- top pros coherents
- top cons coherents
- categorized performance
- synthese globale

Lancer l'analyse en local :

```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="..."
$env:MISTRAL_API_KEY="..."
python analyze_reviews_mistral.py --product-slug spendesk
```

Ou via GitHub Actions :

```text
Actions > Run Mistral Analysis > mode: analyze
```

La Supabase Edge Function `analyze-mistral` existe pour faire tourner cette analyse cote serveur de maniere plus propre, sans exposer la cle Mistral au front.

## Workflows GitHub Actions

- `Scrape Capterra Reviews` : lance le scraper et upload Supabase.
- `Run Mistral Analysis` : genere les insights IA et les sauvegarde.
- `Deploy Supabase Edge Functions` : deploie la fonction `analyze-mistral`.

Secrets utiles :

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MISTRAL_API_KEY
```

Pour deployer l'Edge Function, ajouter aussi :

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_REF
```

## Limites connues

Le scraper fonctionne bien en local. En revanche, les environnements cloud/headless comme GitHub Actions ou Cloud Run peuvent etre davantage detectes par Cloudflare, car ils utilisent des IP de datacenter et des navigateurs jetables.

Pour une V2 vraiment autonome, la meilleure piste serait un VPS prive avec Chrome/profil persistant, lance soit par cron, soit manuellement depuis le dashboard.

## Stack

- Python
- SeleniumBase
- BeautifulSoup
- Supabase
- React / Vite
- Render pour le front
- Mistral pour l'enrichissement IA
