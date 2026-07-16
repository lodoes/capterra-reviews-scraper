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
