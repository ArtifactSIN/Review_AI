# Workspace Overview

Two parallel efforts live in this repository. Keeping them side by side makes it
easy to share data and notes without juggling multiple repos.

## application_to_2209/
- Drafts, diagrams, and supporting material for the TÜBİTAK 2209-A proposal on
  marketplace review authenticity.
- No scraper code should land here so that paperwork stays clean.

## scraper_project/
- Python tooling for gathering and organizing product reviews.
- Includes:
  - `scraper/` with runnable scripts (see `demo_scraper.py`).
  - `data/` containing sample outputs plus scratch storage for new runs.
  - `requirements.txt` for the scraper portion.
  - `README.md` describing usage in detail.

### Run the scraper
```bash
cd scraper_project/scraper
python3 demo_scraper.py --use-sample-data --output-dir ../data
```

Add new top-level folders as needed, but document their purpose here so future
contributors know where things belong.
