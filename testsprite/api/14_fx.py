import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")
import re

DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")
DAY = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def test_fx_lookup() -> None:
    """GET /api/fx gives the ECB rate for EUR to USD as exact text, and a malformed pair is refused with invalid_body."""
    response = requests.get(f"{BASE_URL}/api/fx", params={"from": "EUR", "to": "USD"}, timeout=30)
    expect_status("EUR to USD", response, 200)
    body = response.json()
    expect("EUR to USD keys", sorted(body), ["date", "rate", "source"])
    rate = body["rate"]
    expect("rate is a plain decimal string", isinstance(rate, str) and bool(DECIMAL.match(rate)), True)
    expect("rate is above zero", rate.strip("0.") != "", True)
    expect("date is YYYY-MM-DD", isinstance(body["date"], str) and bool(DAY.match(body["date"])), True)
    expect("source", body["source"], "ECB reference rate")

    lower = requests.get(f"{BASE_URL}/api/fx", params={"from": "EUR", "to": "usd"}, timeout=30)
    expect_status("lowercase code", lower, 400)
    expect("lowercase code", lower.json(), {"error": {"code": "invalid_body"}})

    half = requests.get(f"{BASE_URL}/api/fx", params={"from": "EUR"}, timeout=30)
    expect_status("missing to", half, 400)
    expect("missing to", half.json(), {"error": {"code": "invalid_body"}})


test_fx_lookup()
