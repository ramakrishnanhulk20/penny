import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def test_retry_is_safe() -> None:
    """The same expense sent twice with one clientId is stored once; that clientId with a different body is refused."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: retry", "baseCurrency": "EUR", "members": ["Asha", "Ben"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    group_headers = {**JSON, "x-penny-group": token}
    body = {
        "clientId": os.urandom(16).hex(),
        "description": "Taxi",
        "amount": "12.50",
        "currency": "EUR",
        "rate": None,
        "paidBy": ids["Asha"],
        "split": {"mode": "equal", "members": [ids["Asha"], ids["Ben"]]},
    }

    first = requests.post(f"{BASE_URL}/api/group/expenses", json=body, headers=group_headers, timeout=30)
    expect_status("first send", first, 201)
    second = requests.post(f"{BASE_URL}/api/group/expenses", json=body, headers=group_headers, timeout=30)
    expect_status("repeat send", second, 200)
    first_id = first.json()["expense"]["id"]
    expect("repeat send expense id", second.json()["expense"]["id"], first_id)

    group = requests.get(f"{BASE_URL}/api/group", headers={"x-penny-group": token}, timeout=30).json()
    expect("expenses after a repeat", [expense["id"] for expense in group["expenses"]], [first_id])
    # One 12.50 expense split by two: Asha paid it all and owes 6.25 of it.
    expect(
        "balances",
        group["balances"],
        [{"memberId": ids["Asha"], "amount": "6.25"}, {"memberId": ids["Ben"], "amount": "-6.25"}],
    )

    changed = {**body, "amount": "13.00"}
    conflict = requests.post(f"{BASE_URL}/api/group/expenses", json=changed, headers=group_headers, timeout=30)
    expect_status("same clientId, different body", conflict, 409)
    expect("same clientId, different body", conflict.json(), {"error": {"code": "client_id_conflict"}})

    after = requests.get(f"{BASE_URL}/api/group", headers={"x-penny-group": token}, timeout=30).json()
    expect("expenses after a conflict", [expense["id"] for expense in after["expenses"]], [first_id])


test_retry_is_safe()
