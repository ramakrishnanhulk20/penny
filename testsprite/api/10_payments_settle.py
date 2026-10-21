import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def pay(token, plan_version, payer, payee, amount):
    return requests.post(
        f"{BASE_URL}/api/group/payments",
        json={
            "clientId": os.urandom(16).hex(),
            "planVersion": plan_version,
            "from": payer,
            "to": payee,
            "amount": amount,
            "currency": "EUR",
            "rate": None,
        },
        headers={**JSON, "x-penny-group": token},
        timeout=30,
    )


def test_payments_settle() -> None:
    """Paying every line of the plan settles the group; self and stale payments are refused; undo restores balances."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: payments", "baseCurrency": "EUR", "members": ["Asha", "Ben", "Chen"]},
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
            "description": "Cabin",
            "amount": "90.00",
            "currency": "EUR",
            "rate": None,
            "paidBy": asha,
            "split": {"mode": "equal", "members": [asha, ben, chen]},
        },
        headers={**JSON, "x-penny-group": token},
        timeout=30,
    )
    expect_status("add expense", added, 201)
    group = added.json()["group"]
    opening_version = group["version"]
    # 90.00 / 3 is 30.00 each: Asha paid it all, so she is owed 60.00 and Ben and Chen owe 30.00 each.
    expect(
        "opening balances",
        group["balances"],
        [
            {"memberId": asha, "amount": "60.00"},
            {"memberId": ben, "amount": "-30.00"},
            {"memberId": chen, "amount": "-30.00"},
        ],
    )
    # Both debtors owe only Asha, so each pays her their own 30.00, listed by payer id, then payee id.
    expect(
        "opening plan",
        group["settlement"]["transfers"],
        sorted(
            [{"from": ben, "to": asha, "amount": "30.00"}, {"from": chen, "to": asha, "amount": "30.00"}],
            key=lambda line: (line["from"], line["to"]),
        ),
    )

    ben_paid = pay(token, opening_version, ben, asha, "30.00")
    expect_status("Ben pays Asha", ben_paid, 201)
    group = ben_paid.json()["group"]
    # Ben's 30.00 clears his debt and takes Asha from 60.00 down to 30.00.
    before_chen_pays = [
        {"memberId": asha, "amount": "30.00"},
        {"memberId": ben, "amount": "0.00"},
        {"memberId": chen, "amount": "-30.00"},
    ]
    expect("balances after Ben pays", group["balances"], before_chen_pays)
    chen_line = [{"from": chen, "to": asha, "amount": "30.00"}]
    expect("plan after Ben pays", group["settlement"]["transfers"], chen_line)

    chen_paid = pay(token, group["version"], chen, asha, "30.00")
    expect_status("Chen pays Asha", chen_paid, 201)
    chen_payment_id = chen_paid.json()["payment"]["id"]
    group = chen_paid.json()["group"]
    # Every line of the plan is paid, so every balance is exactly zero.
    expect(
        "balances after both pay",
        group["balances"],
        [
            {"memberId": asha, "amount": "0.00"},
            {"memberId": ben, "amount": "0.00"},
            {"memberId": chen, "amount": "0.00"},
        ],
    )
    expect("plan when settled", group["settlement"]["transfers"], [])

    to_self = pay(token, group["version"], asha, asha, "5.00")
    expect_status("Asha pays Asha", to_self, 400)
    expect("Asha pays Asha", to_self.json(), {"error": {"code": "self_payment"}})

    stale = pay(token, opening_version, ben, asha, "5.00")
    expect_status("payment on an old planVersion", stale, 409)
    expect("payment on an old planVersion", stale.json(), {"error": {"code": "stale_version"}})

    undone = requests.delete(
        f"{BASE_URL}/api/group/payments/{chen_payment_id}", headers={**JSON, "x-penny-group": token}, timeout=30
    )
    expect_status("undo Chen's payment", undone, 200)
    group = undone.json()["group"]
    expect("balances after undo", group["balances"], before_chen_pays)
    expect("plan after undo", group["settlement"]["transfers"], chen_line)


test_payments_settle()
