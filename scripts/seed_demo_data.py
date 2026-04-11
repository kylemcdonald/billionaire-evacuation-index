#!/usr/bin/env python3

import datetime as dt
import pathlib
import random
import sqlite3


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "ews.sqlite"
SCHEMA_PATH = ROOT_DIR / "schema.sql"


def ensure_directories():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def open_db():
    ensure_directories()
    connection = sqlite3.connect(DB_PATH)
    connection.executescript(SCHEMA_PATH.read_text("utf8"))
    return connection


def seed():
    connection = open_db()
    now = dt.datetime.now(dt.timezone.utc)
    tracked = [
        ("d3m001", "N-DEMO1", "Cohort 01"),
        ("d3m002", "N-DEMO2", "Cohort 02"),
        ("d3m003", "N-DEMO3", "Cohort 03"),
        ("d3m004", "N-DEMO4", "Cohort 04"),
        ("d3m005", "N-DEMO5", "Cohort 05"),
        ("d3m006", "N-DEMO6", "Cohort 06"),
        ("d3m007", "N-DEMO7", "Cohort 07"),
        ("d3m008", "N-DEMO8", "Cohort 08"),
    ]

    connection.execute("DELETE FROM tracked_aircraft")
    connection.execute("DELETE FROM observations")
    connection.execute("DELETE FROM rolling_metrics")
    connection.execute("DELETE FROM daily_metrics")
    connection.execute("DELETE FROM live_snapshot")

    connection.executemany(
        """
        INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
        VALUES (?, ?, ?, 'demo', 'Synthetic review data')
        """,
        tracked,
    )

    for day_offset in range(90, 0, -1):
        day = (now - dt.timedelta(days=day_offset)).date()
        daily_unique = 8 + int(4 * random.random()) + (1 if day_offset % 17 == 0 else 0)
        peak_concurrent = max(2, int(daily_unique * 0.55))
        peak_rolling = daily_unique + int(1 + random.random() * 2)

        connection.execute(
            """
            INSERT INTO daily_metrics (
              day,
              unique_airborne_count,
              peak_concurrent_count,
              peak_rolling_24h_count,
              sample_count
            ) VALUES (?, ?, ?, ?, 48)
            """,
            (day.isoformat(), daily_unique, peak_concurrent, peak_rolling),
        )

        for sample_index in range(48):
            sampled_at = dt.datetime.combine(day, dt.time.min, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=30 * sample_index)
            concurrent = max(1, int(peak_concurrent * (0.45 + random.random() * 0.8)))
            rolling = max(concurrent, peak_rolling - int(random.random() * 3))
            connection.execute(
                """
                INSERT INTO rolling_metrics (sampled_at, rolling_24h_count, concurrent_count)
                VALUES (?, ?, ?)
                """,
                (sampled_at.isoformat(), rolling, concurrent),
            )

    live_positions = [
        ("d3m001", "N-DEMO1", "Cohort 01", 40.7128, -74.0060, 39100, 444, 82),
        ("d3m002", "N-DEMO2", "Cohort 02", 51.5072, -0.1276, 40800, 459, 117),
        ("d3m003", "N-DEMO3", "Cohort 03", 25.2048, 55.2708, 38400, 432, 299),
        ("d3m004", "N-DEMO4", "Cohort 04", -23.5505, -46.6333, 36500, 416, 51),
        ("d3m005", "N-DEMO5", "Cohort 05", 35.6764, 139.6500, 40200, 448, 213),
        ("d3m006", "N-DEMO6", "Cohort 06", -33.8688, 151.2093, 35100, 430, 287),
    ]

    for hex_value, registration, label, lat, lon, altitude, speed, track in live_positions:
        connection.execute(
            """
            INSERT INTO live_snapshot (
              hex,
              registration,
              label,
              observed_at,
              lat,
              lon,
              altitude_ft,
              ground_speed_kt,
              track,
              is_airborne,
              source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'demo')
            """,
            (hex_value, registration, label, now.isoformat(), lat, lon, altitude, speed, track),
        )
        connection.execute(
            """
            INSERT INTO observations (
              observed_at,
              hex,
              registration,
              source,
              lat,
              lon,
              altitude_ft,
              ground_speed_kt,
              is_airborne
            ) VALUES (?, ?, ?, 'demo', ?, ?, ?, ?, 1)
            """,
            (now.isoformat(), hex_value, registration, lat, lon, altitude, speed),
        )

    connection.commit()
    connection.close()
    print(f"Seeded demo data into {DB_PATH}")


if __name__ == "__main__":
    seed()
