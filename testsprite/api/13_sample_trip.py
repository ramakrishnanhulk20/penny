import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def test_sample_trip() -> None:
    """POST /api/sample-trip makes the Lisbon trip: 7 expenses, the hand-worked balances and a 3-payment plan."""
    made = requests.post(f"{BASE_URL}/api/sample-trip", headers=JSON, timeout=30)
    expect_status("sample trip", made, 201)
    token = made.json()["token"]

    read = requests.get(f"{BASE_URL}/api/group", headers={"x-penny-group": token}, timeout=30)
    expect_status("read sample trip", read, 200)
    group = read.json()
    expect("name", group["name"], "Lisbon trip")
    expect("base currency", group["baseCurrency"], "EUR")
    expect("members", [member["name"] for member in group["members"]], ["Ana", "Ben", "Cy", "Dev"])
    ids = {member["name"]: member["id"] for member in group["members"]}
    expect("expenses", len(group["expenses"]), 7)
    expect("expense count", group["settlement"]["expenseCount"], 7)

    # Dinner 96.50 / 3 leaves 2 cents for Ana and Ben; groceries 42.75 / 4 leaves 3 for Ana, Ben, Cy; surf 150.00 USD x 0.92 is 138.00.
    expect(
        "balances",
        group["balances"],
        [
            {"memberId": ids["Ana"], "amount": "155.74"},  # +480.00 -120.00 -90.00 -32.17 -18.00 +31.20 -15.60 -10.69 -69.00
            {"memberId": ids["Ben"], "amount": "81.34"},  # -120.00 +360.00 -90.00 -32.17 -18.00 -7.80 -10.69
            {"memberId": ids["Cy"], "amount": "-95.15"},  # -120.00 -90.00 +96.50 -32.16 -7.80 -10.69 +138.00 -69.00
            {"memberId": ids["Dev"], "amount": "-141.93"},  # -120.00 -90.00 +54.00 -18.00 +42.75 -10.68
        ],
    )

    transfers = group["settlement"]["transfers"]
    expect("plan size", len(transfers), 3)
    # No two balances cancel, so all four settle as one group in 3 payments: Dev covers most of Ana, Cy covers Ben and the rest.
    expect(
        "plan",
        transfers,
        sorted(
            [
                {"from": ids["Cy"], "to": ids["Ana"], "amount": "13.81"},
                {"from": ids["Cy"], "to": ids["Ben"], "amount": "81.34"},
                {"from": ids["Dev"], "to": ids["Ana"], "amount": "141.93"},
            ],
            key=lambda line: (line["from"], line["to"]),
        ),
    )


test_sample_trip()
