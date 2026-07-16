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
