import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def test_health_reports_up() -> None:
    """GET /api/health answers 200 with exactly {"status": "up"} and nothing else."""
    response = requests.get(f"{BASE_URL}/api/health", timeout=30)
    expect_status("health", response, 200)
    expect("health body", response.json(), {"status": "up"})


test_health_reports_up()
