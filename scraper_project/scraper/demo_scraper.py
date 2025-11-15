"""Self-contained review scraper demo with optional sample data.

The script demonstrates how to orchestrate multi-item scraping while keeping
selectors configurable and storage structured for ML experiments.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable, Iterator, Optional

import requests
from bs4 import BeautifulSoup


DEFAULT_USER_AGENT = (
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36"
)


# Minimal synthetic HTML so we can run the pipeline without hitting the network.
SAMPLE_PAGES: dict[str, str] = {}


def _register_sample_pages() -> None:
	products = {
		"sample://espresso-machine": {
			"name": "Sample Espresso Machine",
			"pages": [
				{
					"html": """
					<html>
					  <body>
						<h1 class='product-title'>Sample Espresso Machine</h1>
						<article class='review-card'>
						  <h2 class='review-title'>Perfect crema</h2>
						  <p class='review-body'>Steams milk fast and consistent.</p>
						  <span class='review-rating'>4.5</span>
						  <span class='review-author'>Nora</span>
						  <time class='review-date'>2024-10-01</time>
						</article>
						<article class='review-card'>
						  <h2 class='review-title'>Good value</h2>
						  <p class='review-body'>Would recommend for hobbyists.</p>
						  <span class='review-rating'>4.0</span>
						  <span class='review-author'>Luis</span>
						  <time class='review-date'>2024-10-08</time>
						</article>
						<a class='next-page' href='sample://espresso-machine?page=2'>Next</a>
					  </body>
					</html>
					""",
				},
				{
					"html": """
					<html>
					  <body>
						<h1 class='product-title'>Sample Espresso Machine</h1>
						<article class='review-card'>
						  <h2 class='review-title'>Solid overall</h2>
						  <p class='review-body'>Shots are consistent after warmup.</p>
						  <span class='review-rating'>4.2</span>
						  <span class='review-author'>Kai</span>
						  <time class='review-date'>2024-10-12</time>
						</article>
					  </body>
					</html>
					""",
				},
			],
		},
		"sample://smart-kettle": {
			"name": "Sample Smart Kettle",
			"pages": [
				{
					"html": """
					<html>
					  <body>
						<h1 class='product-title'>Sample Smart Kettle</h1>
						<article class='review-card'>
						  <h2 class='review-title'>Quiet boil</h2>
						  <p class='review-body'>Temperature presets are accurate.</p>
						  <span class='review-rating'>5</span>
						  <span class='review-author'>Mina</span>
						  <time class='review-date'>2024-09-19</time>
						</article>
						<article class='review-card'>
						  <h2 class='review-title'>Battery woes</h2>
						  <p class='review-body'>App disconnects sometimes.</p>
						  <span class='review-rating'>3.2</span>
						  <span class='review-author'>Omar</span>
						  <time class='review-date'>2024-09-23</time>
						</article>
					  </body>
					</html>
					""",
				}
			],
		},
	}

	for base_url, meta in products.items():
		for idx, page in enumerate(meta["pages"], start=1):
			page_url = base_url if idx == 1 else f"{base_url}?page={idx}"
			SAMPLE_PAGES[page_url] = page["html"]


_register_sample_pages()


@dataclass
class SelectorConfig:
	review_container: str = ".review-card"
	title: str = ".review-title"
	body: str = ".review-body"
	rating: Optional[str] = ".review-rating"
	author: Optional[str] = ".review-author"
	date: Optional[str] = ".review-date"
	next_page: Optional[str] = ".next-page"
	item_name: Optional[str] = ".product-title"

	@classmethod
	def from_dict(cls, raw: dict) -> "SelectorConfig":
		return cls(**raw)


@dataclass
class ScraperConfig:
	product_urls: list[str]
	selectors: SelectorConfig = field(default_factory=SelectorConfig)
	max_pages_per_product: int = 5
	delay_seconds: float = 1.0
	output_dir: str = "../data"
	user_agent: str = DEFAULT_USER_AGENT

	@classmethod
	def from_json(cls, path: Path) -> "ScraperConfig":
		raw = json.loads(path.read_text())
		selectors = SelectorConfig.from_dict(raw.get("selectors", {}))
		return cls(
			product_urls=raw["product_urls"],
			selectors=selectors,
			max_pages_per_product=raw.get("max_pages_per_product", 5),
			delay_seconds=raw.get("delay_seconds", 1.0),
			output_dir=raw.get("output_dir", "../data"),
			user_agent=raw.get("user_agent", DEFAULT_USER_AGENT),
		)


@dataclass
class Review:
	item_id: str
	item_name: str
	review_id: str
	title: str
	body: str
	rating: Optional[float]
	author: Optional[str]
	date: Optional[str]
	source_url: str


class ReviewScraper:
	def __init__(self, config: ScraperConfig, *, use_sample_data: bool = False) -> None:
		self.config = config
		self.use_sample_data = use_sample_data
		self.session = requests.Session()
		self.session.headers.update({"User-Agent": config.user_agent})

	def scrape_all(self) -> list[Review]:
		aggregated: list[Review] = []
		for url in self.config.product_urls:
			aggregated.extend(self._scrape_product(url))
			time.sleep(self.config.delay_seconds)
		return aggregated

	def _scrape_product(self, url: str) -> list[Review]:
		reviews: list[Review] = []
		seen_pages = 0
		next_url: Optional[str] = url
		while next_url and seen_pages < self.config.max_pages_per_product:
			html = self._fetch(next_url)
			batch, next_url = self._parse_reviews(html, next_url)
			reviews.extend(batch)
			seen_pages += 1
			if next_url and not next_url.startswith("sample://") and not next_url.startswith("http"):
				next_url = requests.compat.urljoin(url, next_url)
		return reviews

	def _fetch(self, url: str) -> str:
		if self.use_sample_data or url.startswith("sample://"):
			if url not in SAMPLE_PAGES:
				raise ValueError(f"No sample HTML registered for {url}")
			return SAMPLE_PAGES[url]
		response = self.session.get(url, timeout=20)
		response.raise_for_status()
		return response.text

	def _parse_reviews(self, html: str, page_url: str) -> tuple[list[Review], Optional[str]]:
		soup = BeautifulSoup(html, "html.parser")
		selectors = self.config.selectors
		item_name = self._extract_text(soup.select_one(selectors.item_name)) if selectors.item_name else ""
		item_id = slugify(item_name or page_url)

		reviews: list[Review] = []
		for block in soup.select(selectors.review_container):
			title = self._extract_text(block.select_one(selectors.title))
			body = self._extract_text(block.select_one(selectors.body))
			rating = self._extract_rating(block.select_one(selectors.rating) if selectors.rating else None)
			author = self._extract_text(block.select_one(selectors.author)) if selectors.author else None
			date = self._extract_text(block.select_one(selectors.date)) if selectors.date else None
			if not body:
				continue
			reviews.append(
				Review(
					item_id=item_id,
					item_name=item_name or item_id,
					review_id=str(uuid.uuid4()),
					title=title or "",
					body=body,
					rating=rating,
					author=author or None,
					date=date or None,
					source_url=page_url,
				)
			)

		next_link = soup.select_one(selectors.next_page) if selectors.next_page else None
		next_href = next_link.get("href") if next_link else None
		return reviews, next_href

	@staticmethod
	def _extract_text(node) -> str:
		return node.get_text(strip=True) if node else ""

	@staticmethod
	def _extract_rating(node) -> Optional[float]:
		if not node:
			return None
		try:
			return float(node.get_text(strip=True))
		except ValueError:
			return None


def slugify(value: str) -> str:
	value = value.lower()
	value = re.sub(r"[^a-z0-9]+", "-", value)
	return re.sub(r"-+", "-", value).strip("-") or "item"


def save_reviews(reviews: Iterable[Review], output_dir: Path) -> Path:
	output_dir.mkdir(parents=True, exist_ok=True)
	by_item: dict[str, list[Review]] = {}
	for review in reviews:
		by_item.setdefault(review.item_id, []).append(review)

	raw_dir = output_dir / "raw"
	raw_dir.mkdir(parents=True, exist_ok=True)
	for item_id, rows in by_item.items():
		path = raw_dir / f"{item_id}.jsonl"
		with path.open("w", encoding="utf-8") as fh:
			for row in rows:
				fh.write(json.dumps(asdict(row)) + "\n")

	aggregate_path = output_dir / "aggregate" / "all_reviews.jsonl"
	aggregate_path.parent.mkdir(parents=True, exist_ok=True)
	with aggregate_path.open("w", encoding="utf-8") as fh:
		for review in reviews:
			fh.write(json.dumps(asdict(review)) + "\n")

	index_path = output_dir / "aggregate" / "review_index.csv"
	with index_path.open("w", newline="", encoding="utf-8") as fh:
		writer = csv.writer(fh)
		writer.writerow(["item_id", "item_name", "review_count"])
		for item_id, rows in by_item.items():
			writer.writerow([item_id, rows[0].item_name, len(rows)])

	return aggregate_path


def build_arg_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(description="Review scraper demo")
	parser.add_argument(
		"--config",
		type=Path,
		help="Path to JSON config with product URLs and selectors",
	)
	parser.add_argument(
		"--output-dir",
		type=Path,
		default=None,
		help="Override output directory defined in the config",
	)
	parser.add_argument(
		"--use-sample-data",
		action="store_true",
		help="Use embedded HTML instead of performing network requests",
	)
	return parser


def load_config(args: argparse.Namespace) -> ScraperConfig:
	if args.config:
		config = ScraperConfig.from_json(args.config)
	else:
		config = ScraperConfig(
			product_urls=["sample://espresso-machine", "sample://smart-kettle"],
		)
	if args.output_dir:
		config.output_dir = str(args.output_dir)
	if args.use_sample_data:
		for url in config.product_urls:
			if not url.startswith("sample://"):
				raise ValueError("Sample mode expects product URLs starting with sample://")
	return config


def main() -> None:
	parser = build_arg_parser()
	args = parser.parse_args()
	config = load_config(args)
	scraper = ReviewScraper(config, use_sample_data=args.use_sample_data or not args.config)
	reviews = scraper.scrape_all()
	aggregate_path = save_reviews(reviews, Path(config.output_dir))
	print(f"Stored {len(reviews)} reviews -> {aggregate_path}")


if __name__ == "__main__":
	main()
