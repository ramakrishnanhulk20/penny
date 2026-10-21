import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")
import secrets

JSON = {"Content-Type": "application/json"}
NOT_FOUND = {"error": {"code": "not_found"}}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def expect_not_found(label, response):
    expect_status(label, response, 404)
    expect(label, response.json(), NOT_FOUND)


def make_group(name):
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": name, "baseCurrency": "EUR", "members": ["Asha", "Ben"]},
        headers=JSON,
        timeout=30,
    )
    expect_status(f"create {name}", created, 201)
    return created.json()


def read_group(headers):
    return requests.get(f"{BASE_URL}/api/group", headers=headers, timeout=30)


def reset_link(old_token, next_token):
    return requests.post(
        f"{BASE_URL}/api/group/reset-link",
        json={"newToken": next_token},
        headers={**JSON, "x-penny-group": old_token},
        timeout=30,
    )


def test_link_secret() -> None:
    """Only the live link opens a group: unknown, malformed, missing, foreign and reset links all get the same 404."""
    expect_not_found("unknown token", read_group({"x-penny-group": secrets.token_urlsafe(16)}))
    expect_not_found("malformed token", read_group({"x-penny-group": secrets.token_urlsafe(16)[:21] + "!"}))
    expect_not_found("missing header", read_group({}))

    group_a = make_group("API suite: link A")
    group_b = make_group("API suite: link B")
    token_a, token_b = group_a["token"], group_b["token"]
    group_a_id = group_a["group"]["id"]
    ids_a = {member["name"]: member["id"] for member in group_a["group"]["members"]}

    added = requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Tickets",
            "amount": "10.00",
            "currency": "EUR",
            "rate": None,
            "paidBy": ids_a["Asha"],
            "split": {"mode": "equal", "members": [ids_a["Asha"], ids_a["Ben"]]},
        },
        headers={**JSON, "x-penny-group": token_a},
        timeout=30,
    )
    expect_status("add expense to A", added, 201)
    expense_a = added.json()["expense"]
    foreign = requests.delete(
        f"{BASE_URL}/api/group/expenses/{expense_a['id']}?version={expense_a['version']}",
        headers={**JSON, "x-penny-group": token_b},
        timeout=30,
    )
    expect_not_found("A's expense with B's token", foreign)
    kept = [expense["id"] for expense in read_group({"x-penny-group": token_a}).json()["expenses"]]
    expect("A's expenses after B's attempt", kept, [expense_a["id"]])

    fresh_token = secrets.token_urlsafe(16)
    reset = reset_link(token_a, fresh_token)
    expect_status("reset A's link", reset, 200)
    expect("group answered by the reset", reset.json()["group"]["id"], group_a_id)

    expect_not_found("A's old token after the reset", read_group({"x-penny-group": token_a}))
    opened = read_group({"x-penny-group": fresh_token})
    expect_status("A's fresh token", opened, 200)
    expect("group opened by the fresh token", opened.json()["id"], group_a_id)
    expect("name read with the fresh token", opened.json()["name"], "API suite: link A")

    resent = reset_link(token_a, fresh_token)
    expect_status("the same reset sent again", resent, 200)
    expect("group answered by the repeated reset", resent.json()["group"]["id"], group_a_id)


test_link_secret()
