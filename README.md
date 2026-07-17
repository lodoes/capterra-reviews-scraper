# Capterra Reviews Scraper

Scraper Python pour extraire les avis Capterra vers CSV et JSON.

Le script utilise SeleniumBase en mode UC/CDP pour charger les pages, contourner les challenges Cloudflare quand c'est possible, puis extrait un maximum d'informations par avis :

- profil reviewer
- role et industrie
- duree d'utilisation
- titre, date et resume
- notes detaillees
- pros et cons
- source de l'avis
- reponse de l'editeur

## Installation

```powershell
pip install -r requirements.txt
```

## Usage

```powershell
python capterra_scraper.py
```

Avec headless + CDP Mode :

```powershell
python capterra_scraper.py --headless
```

Limiter le nombre de pages :

```powershell
python capterra_scraper.py --max-pages 2
```

Changer l'URL :

```powershell
python capterra_scraper.py --url "https://www.capterra.com/p/157515/Spendesk/reviews/"
```

Les exports sont generes dans `resultats/`, qui est ignore par Git.

## Supabase

Le script peut envoyer automatiquement tous les avis dans Supabase apres le scrape.

1. Dans Supabase, ouvre le SQL Editor et execute `supabase_schema.sql`.
2. Dans GitHub, ajoute ces secrets au repo :
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Lance le workflow GitHub Actions `Scrape Capterra Reviews`.

En local, l'upload Supabase se declenche automatiquement si les variables sont presentes :

```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="..."
python capterra_scraper.py --headless
```

Pour forcer une erreur si Supabase n'est pas configure :

```powershell
python capterra_scraper.py --headless --supabase
```

La table par defaut est `capterra_reviews`. Chaque avis est upsert via un `fingerprint` unique, avec l'avis complet stocke dans la colonne JSONB `data`.

## Front analytics public

Le dossier `frontend/` contient un dashboard React public qui lit Supabase et charge toutes les reviews par pagination, pas seulement les dernieres.

Variables d'environnement du front :

```text
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=ta_cle_anon_publique
VITE_SUPABASE_TABLE=capterra_reviews
```

N'utilise jamais la service role key dans le front.

Pour le lancer en local :

```powershell
cd frontend
npm install
npm run dev
```

Pour Render.com :

1. Cree un **Static Site**.
2. Connecte ce repo GitHub.
3. Utilise :
   - Root Directory: `frontend`
   - Build Command: `npm install && npm run build`
   - Publish Directory: `dist`
4. Ajoute les variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_TABLE`.

Le fichier `render.yaml` contient aussi une configuration Blueprint equivalente.

## Insights IA avec Mistral

Le front peut lire des insights IA depuis `capterra_review_insights`. Execute d'abord la partie SQL de `supabase_schema.sql`, puis lance l'analyse cote serveur/local, jamais dans le navigateur.

```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="..."
$env:MISTRAL_API_KEY="..."
$env:MISTRAL_MODEL="mistral-small-latest"
$env:MISTRAL_REVIEW_PROMPT="Group reviews into coherent business themes with clean keywords."
python analyze_reviews_mistral.py --product-slug spendesk
```

Le script regroupe les avis par champs lexicaux coherents : pros, cons, keywords propres, et performance categorisee avec une ligne `Overall Experience`.

Pour tester la cle Mistral sans l'ecrire dans une commande ni dans le repo :

```powershell
.\test_mistral_connection.ps1
```

Le script demande la cle en saisie masquee si `MISTRAL_API_KEY` n'est pas deja defini.

### Depuis l'interface Settings

Le dashboard contient une page **Settings** avec :

- `Test connection` pour verifier la cle et le modele Mistral sans analyser les reviews.
- `Run Mistral analysis` pour generer les insights et les injecter dans le dashboard.
- `AI diagnostics` pour verifier que Supabase, la table insights et la Edge Function sont atteignables.

Le bouton essaie d'abord la Supabase Edge Function. Si elle n'est pas encore deployee et qu'une cle Mistral est saisie dans Settings, le front tente un fallback direct via l'API Mistral depuis le navigateur, puis sauvegarde les insights dans `capterra_review_insights`.

Pour autoriser cette sauvegarde depuis l'interface, execute la derniere version de `supabase_schema.sql` dans Supabase SQL Editor. Elle ajoute les policies `insert/update` limitees au `product_slug = 'spendesk'`.

Mode production recommande : deploie la Supabase Edge Function :

```powershell
supabase functions deploy analyze-mistral
```

Ou lance le workflow GitHub Actions **Deploy Supabase Edge Functions** apres avoir ajoute ces secrets au repo :

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MISTRAL_API_KEY`

Puis configure au minimum le secret Supabase qui permet a la function d'ecrire les insights :

```powershell
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="..."
```

Deux options sont possibles pour Mistral :

1. Test rapide : colle ta cle Mistral dans Settings. Elle reste dans le navigateur et est envoyee a la function au moment du clic.
2. Mode plus propre : configure la cle cote Supabase et laisse le champ API key vide dans Settings.

```powershell
supabase secrets set MISTRAL_API_KEY="..."
supabase secrets set MISTRAL_MODEL="mistral-small-latest"
```

Le front appelle `${VITE_SUPABASE_URL}/functions/v1/analyze-mistral`, la function lit les reviews, appelle Mistral, puis upsert le resultat dans `capterra_review_insights`.

## Google Cloud Run Jobs

Pour Google Cloud, utilise **Cloud Run Jobs**, pas un Cloud Run Service.

Le scraper est une tache batch : il demarre, scrape, stocke dans Supabase, puis s'arrete. Un Cloud Run Service attendrait une app HTTP qui ecoute sur `$PORT`, ce qui n'est pas le cas ici.

Le repo contient un `Dockerfile` qui installe Chromium pour SeleniumBase.

Exemple de build :

```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/capterra-reviews-scraper
```

Creation du job :

```bash
gcloud secrets create supabase-service-role-key --data-file=-

gcloud run jobs create capterra-reviews-scraper \
  --image gcr.io/PROJECT_ID/capterra-reviews-scraper \
  --region europe-west1 \
  --set-env-vars SUPABASE_URL=https://xxxx.supabase.co \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest
```

Execution :

```bash
gcloud run jobs execute capterra-reviews-scraper --region europe-west1
```

Pour tester seulement 2 pages, surcharge la commande du job avec :

```bash
python capterra_scraper.py --headless --supabase --max-pages 2 --out /tmp/resultats
```
