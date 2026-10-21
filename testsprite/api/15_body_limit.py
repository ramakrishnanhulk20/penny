import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

LIMIT = 16 * 1024
VALID = '{"name": "API suite: body limit", "baseCurrency": "EUR", "members": ["Asha", "Ben"]}'


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def padded_to(size):
    return (VALID + " " * (size - len(VALID))).encode("ascii")


def send(body):
    return requests.post(f"{BASE_URL}/api/groups", data=body, headers={"Content-Type": "application/json"}, timeout=30)


def test_body_limit() -> None:
    """A valid create padded with JSON whitespace is accepted at exactly 16 KiB and refused one byte over it."""
    at_limit = padded_to(LIMIT)
    expect("padded body size", len(at_limit), LIMIT)
    # The cap refuses only a body above 16384 bytes, so a body of exactly 16384 is still read.
    expect_status("16384 bytes", send(at_limit), 201)

    refused = send(padded_to(LIMIT + 1))
    expect_status("16385 bytes", refused, 400)
    expect("16385 bytes", refused.json(), {"error": {"code": "invalid_body"}})


test_body_limit()
