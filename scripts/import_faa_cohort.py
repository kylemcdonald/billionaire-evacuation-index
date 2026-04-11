#!/usr/bin/env python3

import argparse
import csv
import datetime as dt
import json
import pathlib
import re
import sqlite3
import urllib.request
import zipfile
from collections import Counter


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews.sqlite"
SCHEMA_PATH = ROOT_DIR / "schema.sql"
FAA_DIR = DATA_DIR / "cache" / "faa"
FAA_ZIP_PATH = FAA_DIR / "ReleasableAircraft.zip"
FAA_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip"

INCLUDE_MANUFACTURER_PATTERNS = [
    r"\bCESSNA\b",
    r"\bTEXTRON AVIATION\b",
    r"\bBOMBARDIER\b",
    r"\bLEARJET\b",
    r"\bRAYTHEON\b",
    r"\bHAWKER BEECHCRAFT\b",
    r"\bDASSAULT\b",
    r"\bGULFSTREAM\b",
    r"\bEMBRAER EXECUTIVE\b",
    r"\bHONDA AIRCRAFT\b",
    r"\bECLIPSE AVIATION\b",
    r"\bPILATUS AIRCRAFT\b",
    r"\bISRAEL AIRCRAFT INDUSTRIES\b",
    r"\bIAI LTD\b",
    r"\bCANADAIR LTD\b",
    r"\bGATES LEARJET\b",
    r"\bBEECH\b",
    r"\bBRITISH AEROSPACE\b",
]

EXCLUDE_MANUFACTURER_PATTERNS = [
    r"\bBOEING\b",
    r"\bAIRBUS\b",
    r"\bMCDONNELL DOUGLAS\b",
    r"\bNORTHROP\b",
]

EXCLUDE_MODEL_PATTERNS = [
    r"\b7[0-9]{2}\b",
    r"\bA[0-9]{3}\b",
    r"\bMD-[0-9]+",
    r"\bDC-[0-9]+",
    r"\bERJ[- ]?(135|140|145|170|175|190|195)\b",
    r"\bEMB[- ]?(120|135|140|145|170|175|190|195)\b",
    r"\b767\b",
    r"\b757\b",
    r"\b737\b",
    r"\b747\b",
    r"\b777\b",
    r"\b787\b",
    r"\bA300\b",
    r"\bA310\b",
    r"\bA318\b",
    r"\bA319\b",
    r"\bA320\b",
    r"\bA321\b",
    r"\bA330\b",
    r"\bA340\b",
    r"\bA350\b",
    r"\bA380\b",
    r"\bKC-",
    r"\bC-[0-9]{2}\b",
    r"\bE-\d",
    r"\bP-\d",
]


def parse_args():
    parser = argparse.ArgumentParser(description="Import an FAA-derived business-jet cohort into SQLite.")
    parser.add_argument("--db", default=str(DB_PATH), help="SQLite database path.")
    parser.add_argument("--faa-zip", default=str(FAA_ZIP_PATH), help="Local FAA registry ZIP path.")
    parser.add_argument("--download-url", default=FAA_URL, help="FAA registry ZIP URL.")
    parser.add_argument("--refresh", action="store_true", help="Force a fresh FAA download.")
    parser.add_argument("--min-seats", type=int, default=4, help="Minimum seat count to include.")
    parser.add_argument("--max-seats", type=int, default=20, help="Maximum seat count to include.")
    return parser.parse_args()


def ensure_directories():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FAA_DIR.mkdir(parents=True, exist_ok=True)


def open_db(path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text("utf8"))
    return connection


def purge_demo_state(connection):
    deleted = connection.execute("DELETE FROM tracked_aircraft WHERE source = 'demo'").rowcount
    connection.execute("DELETE FROM observations WHERE source = 'demo'")
    connection.execute("DELETE FROM live_snapshot WHERE source = 'demo'")

    if deleted:
        connection.execute("DELETE FROM rolling_metrics")
        connection.execute("DELETE FROM daily_metrics")


def download_faa_zip(destination, url, refresh):
    destination = pathlib.Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not refresh:
        return destination

    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        destination.write_bytes(response.read())

    return destination


def load_reference_data(zip_path):
    aircraft_reference = {}
    with zipfile.ZipFile(zip_path) as archive:
        with archive.open("ACFTREF.txt") as file_handle:
            reader = csv.DictReader(
                (line.decode("utf-8-sig", errors="replace") for line in file_handle)
            )
            for row in reader:
                aircraft_reference[row["CODE"].strip()] = {key: value.strip() for key, value in row.items() if key}

    return aircraft_reference


def int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_registration(n_number):
    n_number = n_number.strip()
    return f"N{n_number}" if n_number else None


def build_compiled_patterns():
    return {
        "include_manufacturer": [re.compile(pattern) for pattern in INCLUDE_MANUFACTURER_PATTERNS],
        "exclude_manufacturer": [re.compile(pattern) for pattern in EXCLUDE_MANUFACTURER_PATTERNS],
        "exclude_model": [re.compile(pattern) for pattern in EXCLUDE_MODEL_PATTERNS],
    }


def is_business_jet(manufacturer, model, aircraft_row, master_row, patterns, min_seats, max_seats):
    if master_row["STATUS CODE"] != "V":
        return False

    if master_row["TYPE REGISTRANT"] == "5":
        return False

    if aircraft_row["TYPE-ACFT"] != "5":
        return False

    if aircraft_row["TYPE-ENG"] not in {"4", "5"}:
        return False

    if aircraft_row["BUILD-CERT-IND"] != "0":
        return False

    seat_count = int_or_none(aircraft_row["NO-SEATS"])
    if seat_count is None or not (min_seats <= seat_count <= max_seats):
        return False

    if not any(pattern.search(manufacturer) for pattern in patterns["include_manufacturer"]):
        return False

    if any(pattern.search(manufacturer) for pattern in patterns["exclude_manufacturer"]):
        return False

    if any(pattern.search(model) for pattern in patterns["exclude_model"]):
        return False

    return True


def build_cohort(zip_path, min_seats, max_seats):
    aircraft_reference = load_reference_data(zip_path)
    patterns = build_compiled_patterns()
    cohort = []
    manufacturer_counts = Counter()

    with zipfile.ZipFile(zip_path) as archive:
        with archive.open("MASTER.txt") as file_handle:
            reader = csv.DictReader(
                (line.decode("utf-8-sig", errors="replace") for line in file_handle)
            )
            for row in reader:
                master_row = {key: value.strip() for key, value in row.items() if key}
                hex_code = master_row["MODE S CODE HEX"].strip().lower()
                if not re.fullmatch(r"[0-9a-f]{6}", hex_code):
                    continue

                aircraft_row = aircraft_reference.get(master_row["MFR MDL CODE"].strip())
                if not aircraft_row:
                    continue

                manufacturer = aircraft_row["MFR"].strip()
                model = aircraft_row["MODEL"].strip()
                if not is_business_jet(manufacturer, model, aircraft_row, master_row, patterns, min_seats, max_seats):
                    continue

                registration = normalize_registration(master_row["N-NUMBER"])
                if not registration:
                    continue

                manufacturer_counts[manufacturer] += 1
                cohort.append(
                    {
                        "hex": hex_code,
                        "registration": registration,
                        "label": f"{manufacturer} {model}".strip(),
                        "source": "faa_business_jet",
                        "notes": json.dumps(
                            {
                                "manufacturer": manufacturer,
                                "model": model,
                                "seat_count": int_or_none(aircraft_row["NO-SEATS"]),
                                "aircraft_weight_class": aircraft_row["AC-WEIGHT"].strip(),
                                "type_engine": aircraft_row["TYPE-ENG"].strip(),
                                "imported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                            },
                            separators=(",", ":"),
                        ),
                    }
                )

    return cohort, manufacturer_counts


def import_cohort(connection, entries, zip_path):
    purge_demo_state(connection)
    connection.execute("DELETE FROM tracked_aircraft WHERE source = 'faa_business_jet'")
    connection.executemany(
        """
        INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
        VALUES (:hex, :registration, :label, :source, :notes)
        ON CONFLICT(hex) DO UPDATE SET
          registration = excluded.registration,
          label = excluded.label,
          source = excluded.source,
          notes = excluded.notes
        """,
        entries,
    )
    for key, value in (
        ("faa_registry_zip_path", str(zip_path)),
        ("faa_business_jet_imported_at", dt.datetime.now(dt.timezone.utc).isoformat()),
        ("faa_business_jet_count", str(len(entries))),
    ):
        connection.execute(
            """
            INSERT INTO meta (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )


def main():
    args = parse_args()
    ensure_directories()
    zip_path = download_faa_zip(args.faa_zip, args.download_url, args.refresh)
    connection = open_db(args.db)

    cohort_entries, manufacturer_counts = build_cohort(
        zip_path,
        min_seats=args.min_seats,
        max_seats=args.max_seats,
    )
    import_cohort(connection, cohort_entries, zip_path)
    connection.commit()
    connection.close()

    print(f"Imported {len(cohort_entries)} FAA business-jet aircraft into {args.db}")
    print("Top manufacturers:")
    for manufacturer, count in manufacturer_counts.most_common(12):
        print(f"  {count:5d}  {manufacturer}")


if __name__ == "__main__":
    main()
