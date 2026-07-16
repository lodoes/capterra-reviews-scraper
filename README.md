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
