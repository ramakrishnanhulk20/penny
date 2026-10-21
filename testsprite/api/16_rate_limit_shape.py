import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def test_error_bodies_carry_only_a_code() -> None:
    """Three different bad expenses on a rate-limited route each answer with one error key holding one code key."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: error shape", "baseCurrency": "EUR", "members": ["Asha", "Ben"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    good = {
        "clientId": os.urandom(16).hex(),
        "description": "Bread",
        "amount": "12.50",
        "currency": "EUR",
        "rate": None,
        "paidBy": ids["Asha"],
        "split": {"mode": "equal", "members": [ids["Asha"], ids["Ben"]]},
    }
    cases = [
        ("unknown field", {**good, "note": "extra"}, "invalid_body"),
        ("empty description", {**good, "description": ""}, "bad_description"),
        ("three decimals in EUR", {**good, "amount": "12.505"}, "amount_too_many_decimals"),
    ]

    for label, body, code in cases:
        response = requests.post(
            f"{BASE_URL}/api/group/expenses", json=body, headers={**JSON, "x-penny-group": token}, timeout=30
        )
        expect_status(label, response, 400)
        answer = response.json()
        expect(f"{label}, top-level keys", list(answer), ["error"])
        expect(f"{label}, keys inside error", list(answer["error"]) if isinstance(answer["error"], dict) else answer["error"], ["code"])
        expect(label, answer, {"error": {"code": code}})


test_error_bodies_carry_only_a_code()
