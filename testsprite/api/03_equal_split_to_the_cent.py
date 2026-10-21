import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def cents(text):
    sign = -1 if text.startswith("-") else 1
    whole, _, fraction = text.lstrip("-").partition(".")
    return sign * (int(whole) * 100 + int(fraction))


def test_equal_split_to_the_cent() -> None:
    """Asha pays 100.00 EUR split equally by Asha, Ben and Chen: the leftover cent goes to Asha, listed first."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: equal split", "baseCurrency": "EUR", "members": ["Asha", "Ben", "Chen"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    asha, ben, chen = ids["Asha"], ids["Ben"], ids["Chen"]

    added = requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Dinner",
            "amount": "100.00",
            "currency": "EUR",
            "rate": None,
            "paidBy": asha,
            "split": {"mode": "equal", "members": [asha, ben, chen]},
        },
        headers={**JSON, "x-penny-group": token},
        timeout=30,
    )
    expect_status("add expense", added, 201)
    # 10000 cents / 3 is 3333 each with 1 cent left; all fractions tie, so the first listed (Asha) takes it.
    expect(
        "parts",
        added.json()["expense"]["parts"],
        [
            {"memberId": asha, "amount": "33.34", "baseAmount": "33.34"},
            {"memberId": ben, "amount": "33.33", "baseAmount": "33.33"},
            {"memberId": chen, "amount": "33.33", "baseAmount": "33.33"},
        ],
    )

    read = requests.get(f"{BASE_URL}/api/group", headers={"x-penny-group": token}, timeout=30)
    expect_status("read group", read, 200)
    group = read.json()
    # Asha paid 100.00 and owes 33.34 of it; Ben and Chen each owe 33.33. A positive balance has no sign.
    expect(
        "balances",
        group["balances"],
        [
            {"memberId": asha, "amount": "66.66"},
            {"memberId": ben, "amount": "-33.33"},
            {"memberId": chen, "amount": "-33.33"},
        ],
    )
    expect("balances summed in cents", sum(cents(row["amount"]) for row in group["balances"]), 0)
    expect("total", group["total"], "0.00")
    # Each debtor owes only Asha, so each pays her their own 33.33; the server lists by payer id, then payee id.
    expect(
        "plan",
        group["settlement"]["transfers"],
        sorted(
            [{"from": ben, "to": asha, "amount": "33.33"}, {"from": chen, "to": asha, "amount": "33.33"}],
            key=lambda line: (line["from"], line["to"]),
        ),
    )


test_equal_split_to_the_cent()
