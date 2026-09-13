#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def parse_args(argv):
    """Parse zero to two 4-digit years and an optional text string in any order."""
    if not argv:
        return [], ""

    if argv[0] in {"-h", "--help"}:
        print("Usage: FDA_data_analysis.py [YEAR [YEAR]] [TEXT]")
        print("Accepts zero to two 4-digit years in any order, plus an optional text string.")
        raise SystemExit(0)

    years = []
    text_parts = []

    for token in argv:
        if re.fullmatch(r"\d{4}", token):
            if len(years) >= 2:
                raise ValueError(f"Too many years provided: {token}")
            years.append(int(token))
        else:
            text_parts.append(token)

    text = " ".join(text_parts).strip()
    return years, text


def iter_ndjson_files(data_dir):
    if not os.path.isdir(data_dir):
        return []

    files = []
    for root, _, filenames in os.walk(data_dir):
        for filename in sorted(filenames):
            if filename.endswith(".ndjson"):
                files.append(os.path.join(root, filename))
    return files


def record_in_year_range(record, start_year, end_year):
    date_created = record.get("date_created")
    if not isinstance(date_created, str) or len(date_created) < 4:
        return False

    try:
        record_year = int(date_created[:4])
    except ValueError:
        return False

    return start_year <= record_year <= end_year


def record_matches_text(record, text):
    if not text:
        return True

    products = record.get("products") or []
    if not isinstance(products, list):
        return False

    for product in products:
        if not isinstance(product, dict):
            continue
        if product.get("role", "").lower() != "suspect":
            continue

        name_brand = product.get("name_brand") or ""
        if isinstance(name_brand, str) and text.lower() in name_brand.lower():
            return True

    return False


def iter_matching_records(years, text):
    current_year = datetime.now().year

    if not years:
        start_year = None
        end_year = None
    elif len(years) == 1:
        start_year = years[0]
        end_year = current_year
    else:
        start_year = min(years)
        end_year = max(years)

    for file_path in iter_ndjson_files(DATA_DIR):
        with open(file_path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue

                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if not isinstance(record, dict):
                    continue

                if start_year is not None and end_year is not None:
                    if not record_in_year_range(record, start_year, end_year):
                        continue

                if not record_matches_text(record, text):
                    continue

                yield record


def summarize_records(records):
    counts = {
        "outcomes": {},
        "reactions": {},
        "suspect_products": {},
        "consumer_ages": [],
    }

    def normalize_reaction_name(value):
        if not isinstance(value, str):
            return ""

        text = value.strip().lower()
        text = text.replace("&", " and ")
        text = re.sub(r"[^a-z0-9]+", " ", text)
        text = re.sub(r"\s+", " ", text).strip()

        aliases = {
            "diarrhoea": "diarrhea",
            "diarrhea": "diarrhea",
            "hospitalisation": "hospitalization",
            "hospitalization": "hospitalization",
            "dyspnoea": "dyspnea",
            "dyspnea": "dyspnea",
            "oedema": "edema",
            "edema": "edema",
            "paraesthesia": "paresthesia",
            "paresthesia": "paresthesia",
            "hypoaesthesia": "hypoesthesia",
            "hypoesthesia": "hypoesthesia",
            "vomitting": "vomiting",
            "vomit": "vomiting",
        }
        return aliases.get(text, text)

    def parse_age(value):
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            age = int(value)
            return age if 0 <= age <= 110 else None
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned:
                return None
            if cleaned.isdigit():
                age = int(cleaned)
                return age if 0 <= age <= 110 else None
            try:
                numeric = float(cleaned)
                if numeric.is_integer() and 0 <= numeric <= 110:
                    return int(numeric)
            except ValueError:
                pass
        return None

    for record in records:
        outcomes = record.get("outcomes") or []
        if isinstance(outcomes, list):
            for outcome in outcomes:
                if isinstance(outcome, str):
                    counts["outcomes"][outcome] = counts["outcomes"].get(outcome, 0) + 1

        reactions = record.get("reactions") or []
        if isinstance(reactions, list):
            for reaction in reactions:
                if isinstance(reaction, str):
                    normalized = normalize_reaction_name(reaction)
                    if normalized:
                        counts["reactions"][normalized] = counts["reactions"].get(normalized, 0) + 1

        products = record.get("products") or []
        if isinstance(products, list):
            for product in products:
                if not isinstance(product, dict):
                    continue
                if product.get("role", "").lower() != "suspect":
                    continue
                name_brand = product.get("name_brand") or ""
                if isinstance(name_brand, str) and name_brand.strip():
                    counts["suspect_products"][name_brand] = counts["suspect_products"].get(name_brand, 0) + 1

        consumer = record.get("consumer") or {}
        if isinstance(consumer, dict):
            age = parse_age(consumer.get("age"))
            if age is not None:
                counts["consumer_ages"].append(age)

    total_records = 0
    for _ in records:
        total_records += 1

    age_array = np.asarray(counts["consumer_ages"], dtype=float)
    avg_age = float(np.mean(age_array)) if age_array.size else 0.0

    def top_n(counter, n=25):
        return sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:n]

    return {
        "total_records": total_records,
        "top_outcomes": top_n(counts["outcomes"]),
        "top_reactions": top_n(counts["reactions"]),
        "top_suspect_products": top_n(counts["suspect_products"]),
        "average_consumer_age": avg_age,
    }


def save_charts(records):
    charts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "charts")
    os.makedirs(charts_dir, exist_ok=True)

    year_counts = {}
    ages = []

    for record in records:
        date_created = record.get("date_created") or ""
        year = date_created[:4] if isinstance(date_created, str) and len(date_created) >= 4 else None
        if year and year.isdigit():
            year_counts[int(year)] = year_counts.get(int(year), 0) + 1

        consumer = record.get("consumer") or {}
        if isinstance(consumer, dict):
            age = consumer.get("age")
            if isinstance(age, bool):
                continue
            if isinstance(age, str):
                cleaned = age.strip()
                if cleaned.isdigit():
                    age_int = int(cleaned)
                    if 0 <= age_int <= 110:
                        ages.append(age_int)
            elif isinstance(age, (int, float)):
                age_int = int(age)
                if 0 <= age_int <= 110:
                    ages.append(age_int)

    output_path = os.path.join(charts_dir, "fda_data_summary.png")

    if year_counts or ages:
        fig, axes = plt.subplots(1, 2, figsize=(16, 6))

        if year_counts:
            sorted_years = sorted(year_counts.items())
            years = [str(y) for y, _ in sorted_years]
            counts = [c for _, c in sorted_years]
            axes[0].bar(years, counts, color="steelblue")
            axes[0].set_title("Total cases by year")
            axes[0].set_xlabel("Year")
            axes[0].set_ylabel("Cases")
            fig.autofmt_xdate()

        if ages:
            age_array = np.asarray(ages, dtype=float)
            min_age = int(np.min(age_array))
            max_age = int(np.max(age_array))
            bins = np.arange(min_age, max_age + 2, 1)
            hist_counts, hist_bins = np.histogram(age_array, bins=bins)
            axes[1].bar(hist_bins[:-1], hist_counts, width=1.0, align="edge", edgecolor="black", color="darkseagreen")
            axes[1].set_title("Consumer age distribution")
            axes[1].set_xlabel("Age (years)")
            axes[1].set_ylabel("Count")
            step = max(1, (max_age - min_age) // 10 if max_age > min_age else 1)
            axes[1].set_xticks(np.arange(min_age, max_age + 1, step))

        if not year_counts:
            axes[0].set_visible(False)
        if not ages:
            axes[1].set_visible(False)

        fig.tight_layout()
        fig.savefig(output_path, dpi=200)
        plt.close(fig)
    else:
        fig, ax = plt.subplots(figsize=(10, 6))
        ax.text(0.5, 0.5, "No data available", ha="center", va="center")
        ax.axis("off")
        fig.tight_layout()
        fig.savefig(output_path, dpi=200)
        plt.close(fig)


def main():
    try:
        years, text = parse_args(sys.argv[1:])
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        print("Usage: FDA_data_analysis.py [YEAR [YEAR]] [TEXT]", file=sys.stderr)
        raise SystemExit(2)

    records = list(iter_matching_records(years, text))
    summary = summarize_records(records)
    save_charts(records)

    print(f"Total records: {summary['total_records']}")
    print("Top 25 outcomes:")
    for outcome, count in summary["top_outcomes"]:
        print(f"  {outcome}: {count}")

    print("Top 25 reactions:")
    for reaction, count in summary["top_reactions"]:
        print(f"  {reaction}: {count}")

    print("Top 25 suspect products:")
    for product, count in summary["top_suspect_products"]:
        print(f"  {product}: {count}")

    print(f"Average consumer age: {summary['average_consumer_age']:.2f}")
    print("Chart saved to ./charts")


if __name__ == "__main__":
    main()
