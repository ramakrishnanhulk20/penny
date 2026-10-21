import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def test_members_and_currency() -> None:
    """Members join once per name, the base currency moves only before money, and only members with no history leave."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: members", "baseCurrency": "EUR", "members": ["Asha", "Ben"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    asha, ben = ids["Asha"], ids["Ben"]
    group_headers = {**JSON, "x-penny-group": token}

    joined = requests.post(f"{BASE_URL}/api/group/members", json={"name": "Chen"}, headers=group_headers, timeout=30)
    expect_status("add Chen", joined, 201)
    chen = joined.json()["member"]["id"]
    expect("added member name", joined.json()["member"]["name"], "Chen")
    # A member who joins later goes to the end of the list.
    expect("members after add", [member["name"] for member in joined.json()["group"]["members"]], ["Asha", "Ben", "Chen"])

    again = requests.post(f"{BASE_URL}/api/group/members", json={"name": "Chen"}, headers=group_headers, timeout=30)
    expect_status("add Chen again", again, 400)
    expect("add Chen again", again.json(), {"error": {"code": "duplicate_member_name"}})

    rebased = requests.patch(f"{BASE_URL}/api/group", json={"baseCurrency": "USD"}, headers=group_headers, timeout=30)
    expect_status("base to USD before any money", rebased, 200)
    expect("base after change", rebased.json()["group"]["baseCurrency"], "USD")

    spent = requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Lunch",
            "amount": "10.00",
            "currency": "USD",
            "rate": None,
            "paidBy": asha,
            "split": {"mode": "equal", "members": [asha, ben]},
        },
        headers=group_headers,
        timeout=30,
    )
    expect_status("add expense", spent, 201)

    locked = requests.patch(f"{BASE_URL}/api/group", json={"baseCurrency": "EUR"}, headers=group_headers, timeout=30)
    expect_status("base to EUR after money", locked, 409)
    expect("base to EUR after money", locked.json(), {"error": {"code": "base_locked"}})

    in_use = requests.delete(f"{BASE_URL}/api/group/members/{ben}", headers=group_headers, timeout=30)
    expect_status("remove Ben, who has history", in_use, 409)
    expect("remove Ben, who has history", in_use.json(), {"error": {"code": "member_in_use"}})

    removed = requests.delete(f"{BASE_URL}/api/group/members/{chen}", headers=group_headers, timeout=30)
    expect_status("remove Chen, who has none", removed, 200)
    expect("members after removing Chen", [member["name"] for member in removed.json()["group"]["members"]], ["Asha", "Ben"])


test_members_and_currency()
