import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def add_expense(token, amount, paid_by, split):
    return requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Shared cost",
            "amount": amount,
            "currency": "EUR",
            "rate": None,
            "paidBy": paid_by,
            "split": split,
        },
        headers={**JSON, "x-penny-group": token},
        timeout=30,
    )


def test_shares_and_exact() -> None:
    """Shares of 1 and 2 with Chen at 0 left out, an exact split that does not add up, and one that does."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: shares and exact", "baseCurrency": "EUR", "members": ["Asha", "Ben", "Chen"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    asha, ben, chen = ids["Asha"], ids["Ben"], ids["Chen"]

    literal_zero = add_expense(
        token,
        "100.00",
        asha,
        {"mode": "shares", "parts": [{"memberId": asha, "weight": 1}, {"memberId": ben, "weight": 2}, {"memberId": chen, "weight": 0}]},
    )
    expect_status("weight 0 sent", literal_zero, 400)
    expect("weight 0 sent", literal_zero.json(), {"error": {"code": "split_bad_weight"}})

    shares = add_expense(
        token, "100.00", asha, {"mode": "shares", "parts": [{"memberId": asha, "weight": 1}, {"memberId": ben, "weight": 2}]}
    )
    expect_status("shares", shares, 201)
    # 10000 x 1/3 is 3333 rest 1 and 10000 x 2/3 is 6666 rest 2: the spare cent goes to the larger rest, Ben.
    expect(
        "shares parts",
        shares.json()["expense"]["parts"],
        [
            {"memberId": asha, "amount": "33.33", "baseAmount": "33.33", "weight": 1},
            {"memberId": ben, "amount": "66.67", "baseAmount": "66.67", "weight": 2},
        ],
    )

    mismatch = add_expense(
        token, "50.00", ben, {"mode": "exact", "parts": [{"memberId": asha, "amount": "20.00"}, {"memberId": chen, "amount": "20.00"}]}
    )
    expect_status("exact mismatch", mismatch, 400)
    expect("exact mismatch", mismatch.json(), {"error": {"code": "split_exact_sum_mismatch"}})

    exact = add_expense(
        token, "50.00", ben, {"mode": "exact", "parts": [{"memberId": asha, "amount": "20.00"}, {"memberId": chen, "amount": "30.00"}]}
    )
    expect_status("exact", exact, 201)
    # An exact split is stored as typed: 20.00 + 30.00 is the 50.00 total, nothing rounded.
    expect(
        "exact parts",
        exact.json()["expense"]["parts"],
        [
            {"memberId": asha, "amount": "20.00", "baseAmount": "20.00"},
            {"memberId": chen, "amount": "30.00", "baseAmount": "30.00"},
        ],
    )

    group = requests.get(f"{BASE_URL}/api/group", headers={"x-penny-group": token}, timeout=30).json()
    expect("expenses stored", len(group["expenses"]), 2)
    # Asha +100.00 -33.33 -20.00, Ben -66.67 +50.00, Chen -30.00: the two refused requests moved nothing.
    expect(
        "balances",
        group["balances"],
        [
            {"memberId": asha, "amount": "46.67"},
            {"memberId": ben, "amount": "-16.67"},
            {"memberId": chen, "amount": "-30.00"},
        ],
    )


test_shares_and_exact()
