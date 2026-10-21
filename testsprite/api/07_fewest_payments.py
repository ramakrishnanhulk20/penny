import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def greedy_payment_count(balances):
    left = dict(balances)
    payments = 0
    while any(left.values()):
        debtor = min(left, key=left.get)
        creditor = max(left, key=left.get)
        amount = min(-left[debtor], left[creditor])
        left[debtor] += amount
        left[creditor] -= amount
        payments += 1
    return payments


def test_fewest_payments() -> None:
    """The Lake house group from the browser suite settles in 3 payments where largest-debtor-pays-largest-creditor needs 4."""
    people = ["Ana", "Ben", "Cy", "Dev", "Eli"]
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "Lake house", "baseCurrency": "EUR", "members": people},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    everyone = [ids[name] for name in people]

    for description, amount, payer in [("Hotel", "60.00", "Ana"), ("Car", "55.00", "Ben"), ("Food", "50.00", "Cy"), ("Parking", "10.00", "Eli")]:
        added = requests.post(
            f"{BASE_URL}/api/group/expenses",
            json={
                "clientId": os.urandom(16).hex(),
                "description": description,
                "amount": amount,
                "currency": "EUR",
                "rate": None,
                "paidBy": ids[payer],
                "split": {"mode": "equal", "members": everyone},
            },
            headers={**JSON, "x-penny-group": token},
            timeout=30,
        )
        expect_status(description, added, 201)

    group = requests.get(f"{BASE_URL}/api/group", headers={"x-penny-group": token}, timeout=30).json()
    # Each person owes a fifth of each bill (12.00, 11.00, 10.00, 2.00): Ana 60-35, Ben 55-35, Cy 50-35, Dev -35, Eli 10-35.
    expect(
        "balances",
        group["balances"],
        [
            {"memberId": ids["Ana"], "amount": "25.00"},
            {"memberId": ids["Ben"], "amount": "20.00"},
            {"memberId": ids["Cy"], "amount": "15.00"},
            {"memberId": ids["Dev"], "amount": "-35.00"},
            {"memberId": ids["Eli"], "amount": "-25.00"},
        ],
    )
    # Greedy on these balances: Dev pays Ana 25, Eli pays Ben 20, Dev pays Cy 10, Eli pays Cy 5.
    expect("greedy plan size", greedy_payment_count({"Ana": 2500, "Ben": 2000, "Cy": 1500, "Dev": -3500, "Eli": -2500}), 4)

    transfers = group["settlement"]["transfers"]
    expect("plan size", len(transfers), 3)
    # Eli and Ana cancel out as a pair, and Ben plus Cy exactly cover Dev, so two closed groups need 1 + 2 payments.
    expect(
        "plan",
        transfers,
        sorted(
            [
                {"from": ids["Dev"], "to": ids["Ben"], "amount": "20.00"},
                {"from": ids["Dev"], "to": ids["Cy"], "amount": "15.00"},
                {"from": ids["Eli"], "to": ids["Ana"], "amount": "25.00"},
            ],
            key=lambda line: (line["from"], line["to"]),
        ),
    )
    expect("expense count", group["settlement"]["expenseCount"], 4)


test_fewest_payments()
