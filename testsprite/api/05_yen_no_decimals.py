import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def add_yen(token, amount, asha, ben, chen):
    return requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Ramen",
            "amount": amount,
            "currency": "JPY",
            "rate": None,
            "paidBy": asha,
            "split": {"mode": "equal", "members": [asha, ben, chen]},
        },
        headers={**JSON, "x-penny-group": token},
        timeout=30,
    )


def test_yen_has_no_decimals() -> None:
    """A JPY group: 1000 yen split three ways is 334, 333, 333, and 100.5 yen is refused."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: yen", "baseCurrency": "JPY", "members": ["Asha", "Ben", "Chen"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    asha, ben, chen = ids["Asha"], ids["Ben"], ids["Chen"]

    added = add_yen(token, "1000", asha, ben, chen)
    expect_status("1000 JPY", added, 201)
    expense = added.json()["expense"]
    expect("amount", expense["amount"], "1000")
    # The yen has no minor unit: 1000 / 3 is 333 each with 1 yen left, which goes to Asha, listed first.
    expect(
        "parts",
        expense["parts"],
        [
            {"memberId": asha, "amount": "334", "baseAmount": "334"},
            {"memberId": ben, "amount": "333", "baseAmount": "333"},
            {"memberId": chen, "amount": "333", "baseAmount": "333"},
        ],
    )

    half = add_yen(token, "100.5", asha, ben, chen)
    expect_status("100.5 JPY", half, 400)
    expect("100.5 JPY", half.json(), {"error": {"code": "amount_too_many_decimals"}})


test_yen_has_no_decimals()
