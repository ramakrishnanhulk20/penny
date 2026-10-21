import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def add_expense(token, amount, currency, rate, paid_by, members):
    return requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Taxi",
            "amount": amount,
            "currency": currency,
            "rate": rate,
            "paidBy": paid_by,
            "split": {"mode": "equal", "members": members},
        },
        headers={**JSON, "x-penny-group": token},
        timeout=30,
    )


def test_rates_and_rounding() -> None:
    """A EUR group with a 10.05 USD expense at 0.5 rounds once, half up, and the rate rules refuse the wrong cases."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: rates", "baseCurrency": "EUR", "members": ["Asha", "Ben"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    asha, ben = ids["Asha"], ids["Ben"]

    added = add_expense(token, "10.05", "USD", "0.5", asha, [asha, ben])
    expect_status("10.05 USD at 0.5", added, 201)
    expense = added.json()["expense"]
    expect("amount", expense["amount"], "10.05")
    expect("currency", expense["currency"], "USD")
    expect("rate", expense["rate"], "0.5")
    # 1005 cents x 0.5 is 502.5 cents, exactly halfway, and half up gives 503: the "= 5.03 EUR at 0.5" the browser suite expects.
    expect("base amount", expense["baseAmount"], "5.03")
    # USD 1005 / 2 is 502 rest 1 to Asha; 503 re-split 503:502 is 251 rest 754 and 251 rest 251, so Asha gets the cent.
    expect(
        "parts",
        expense["parts"],
        [
            {"memberId": asha, "amount": "5.03", "baseAmount": "2.52"},
            {"memberId": ben, "amount": "5.02", "baseAmount": "2.51"},
        ],
    )
    # Asha is credited the 5.03 she paid less her own 2.52; Ben owes his 2.51.
    expect(
        "balances",
        added.json()["group"]["balances"],
        [{"memberId": asha, "amount": "2.51"}, {"memberId": ben, "amount": "-2.51"}],
    )

    no_rate = add_expense(token, "10.00", "USD", None, asha, [asha, ben])
    expect_status("USD without a rate", no_rate, 400)
    expect("USD without a rate", no_rate.json(), {"error": {"code": "rate_required"}})

    base_with_rate = add_expense(token, "10.00", "EUR", "0.5", asha, [asha, ben])
    expect_status("EUR with a rate", base_with_rate, 400)
    expect("EUR with a rate", base_with_rate.json(), {"error": {"code": "rate_forbidden"}})


test_rates_and_rounding()
