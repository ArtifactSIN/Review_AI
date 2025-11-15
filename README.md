# Review AI Workspace

Research project for Tübitak 2209-A focused on detecting bot or unwanted marketplace reviews, plus a standalone scraping demo you can reuse for future experiments. Use the sections below to keep each track separate.

## application_to_2209/
- Proposal and research materials (docs, diagrams, reports) for the Tübitak submission.
- Stays independent from the scraping pipeline so documentation changes do not interfere with code.

## scraper_project/
- End-to-end scraping demo plus structured outputs meant for ML evaluation.
- Contents:
  - `scraper/` – runnable scripts such as `demo_scraper.py`.
  - `data/` – sample raw/aggregate review dumps emitted by the demo.
  - `requirements.txt` – Python dependencies for the demo.
  - `README.md` – scraper-specific instructions.

### Quick start for the scraper
```bash
cd scraper_project/scraper
python3 demo_scraper.py --use-sample-data --output-dir ../data
```

Feel free to add more top-level directories alongside these two; this README is meant to keep their scopes clear.
