import datetime
from dataclasses import dataclass

import numpy as np


def point_to_str(point):
    hex_value = f"{point & 0xFFFFFF:06x}"
    return ("~" + hex_value) if (point & 0x1000000) else hex_value


def str_to_point(value):
    if value[0] == "~":
        return int(value[1:], 16) | 0x1000000
    return int(value, 16)


def normalize_hex_filter(hex_filter):
    if not hex_filter:
        return False, set()

    normalized = set()
    for value in hex_filter:
        if isinstance(value, int):
            normalized.add(value)
        else:
            normalized.add(str_to_point(value))

    return True, normalized


@dataclass
class Slice:
    timestamp: datetime.datetime
    callsigns: list
    telemetry: list


@dataclass
class Callsign:
    hex: str
    flight: str
    squawk: str


@dataclass
class Telemetry:
    hex: str
    type: str
    lat: float
    lon: float
    alt: float
    gs: float


def parse_heatmap(filename, bbox=None, return_callsigns=True, hex_filter=None):
    with open(filename, "rb") as file_handle:
        raw = file_handle.read()

    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_u = points_u8.view(np.uint32)
    points = points_u8.view(np.int32)

    if bbox is not None:
        bbox = [bbox[0] * 1e6, bbox[1] * 1e6, bbox[2] * 1e6, bbox[3] * 1e6]

    slice_begin_marker = 0x0E7F7C9D
    type_list = [
        "adsb_icao",
        "adsb_icao_nt",
        "adsr_icao",
        "tisb_icao",
        "adsc",
        "mlat",
        "other",
        "mode_s",
        "adsb_other",
        "adsr_other",
        "tisb_trackfile",
        "tisb_other",
        "mode_ac",
    ]

    index = 0
    for index in range(len(points)):
        if points[index] == slice_begin_marker:
            break

    filter_hex, hex_filter = normalize_hex_filter(hex_filter)
    data = []

    while index < len(points):
        callsigns = []
        telemetry = []

        now = points_u[index + 2] / 1000 + points_u[index + 1] * 4294967.296
        timestamp = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc)
        index += 4

        while index < len(points) and points[index] != slice_begin_marker:
            point0 = points[index]

            if filter_hex and point0 not in hex_filter:
                index += 4
                continue

            point1 = points[index + 1]
            point2 = points[index + 2]

            if point1 > 1073741824:
                if not return_callsigns:
                    index += 4
                    continue

                hex_value = point_to_str(point0)
                flight = None
                if points_u8[4 * (index + 2)] != 0:
                    flight = "".join(chr(points_u8[4 * (index + 2) + offset]) for offset in range(8)).strip()

                squawk = str(point1 & 0xFFFF).zfill(4)
                callsigns.append(Callsign(hex=hex_value, flight=flight, squawk=squawk))
                index += 4
                continue

            lat = point1
            lon = point2

            if bbox is not None:
                if lat < bbox[0] or lat > bbox[2] or lon < bbox[1] or lon > bbox[3]:
                    index += 4
                    continue

            lat /= 1e6
            lon /= 1e6
            hex_value = point_to_str(point0)
            type_index = point0 >> 27 & 0x1F
            point3 = points[index + 3]

            alt = point3 & 65535
            if alt & 32768:
                alt |= -65536
            if alt == -123:
                alt = "ground"
            else:
                alt *= 25

            gs = point3 >> 16
            if gs == -1:
                gs = None
            else:
                gs /= 10

            telemetry.append(
                Telemetry(
                    hex=hex_value,
                    type=type_list[type_index] if type_index < len(type_list) else "unknown",
                    lat=lat,
                    lon=lon,
                    alt=alt,
                    gs=gs,
                )
            )
            index += 4

        if telemetry or callsigns:
            data.append(Slice(timestamp=timestamp, callsigns=callsigns, telemetry=telemetry))

    return data
