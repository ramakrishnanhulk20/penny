import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

JSON = {"Content-Type": "application/json"}


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def edit_body(version, amount, asha, ben):
    return {
        "version": version,
        "description": "Groceries",
        "amount": amount,
        "currency": "EUR",
        "rate": None,
        "paidBy": asha,
        "split": {"mode": "equal", "members": [asha, ben]},
    }


def test_versions() -> None:
    """Edits and deletes land only from the version the editor saw; a stale one is refused with stale_version."""
    created = requests.post(
        f"{BASE_URL}/api/groups",
        json={"name": "API suite: versions", "baseCurrency": "EUR", "members": ["Asha", "Ben"]},
        headers=JSON,
        timeout=30,
    )
    expect_status("create", created, 201)
    token = created.json()["token"]
    ids = {member["name"]: member["id"] for member in created.json()["group"]["members"]}
    asha, ben = ids["Asha"], ids["Ben"]
    group_headers = {**JSON, "x-penny-group": token}

    added = requests.post(
        f"{BASE_URL}/api/group/expenses",
        json={
            "clientId": os.urandom(16).hex(),
            "description": "Groceries",
            "amount": "20.00",
            "currency": "EUR",
            "rate": None,
            "paidBy": asha,
            "split": {"mode": "equal", "members": [asha, ben]},
        },
        headers=group_headers,
        timeout=30,
    )
    expect_status("add", added, 201)
    expense_id = added.json()["expense"]["id"]
    seen = added.json()["expense"]["version"]
    url = f"{BASE_URL}/api/group/expenses/{expense_id}"

    edited = requests.patch(url, json=edit_body(seen, "30.00", asha, ben), headers=group_headers, timeout=30)
    expect_status("edit from the current version", edited, 200)
    moved_to = edited.json()["expense"]["version"]
    # Each accepted edit moves the expense on by exactly one version.
    expect("version after edit", moved_to, seen + 1)
    # 30.00 split by two after the edit: Asha paid it and owes 15.00 of it.
    expect(
        "balances after edit",
        edited.json()["group"]["balances"],
        [{"memberId": asha, "amount": "15.00"}, {"memberId": ben, "amount": "-15.00"}],
    )

    stale_edit = requests.patch(url, json=edit_body(seen, "40.00", asha, ben), headers=group_headers, timeout=30)
    expect_status("edit from the old version", stale_edit, 409)
    expect("edit from the old version", stale_edit.json(), {"error": {"code": "stale_version"}})

    stale_delete = requests.delete(f"{url}?version={seen}", headers=group_headers, timeout=30)
    expect_status("delete from the old version", stale_delete, 409)
    expect("delete from the old version", stale_delete.json(), {"error": {"code": "stale_version"}})

    deleted = requests.delete(f"{url}?version={moved_to}", headers=group_headers, timeout=30)
    expect_status("delete from the current version", deleted, 200)
    group = deleted.json()["group"]
    # With the only expense gone nobody owes anything.
    expect(
        "balances after delete",
        group["balances"],
        [{"memberId": asha, "amount": "0.00"}, {"memberId": ben, "amount": "0.00"}],
    )
    expect("expenses after delete", group["expenses"], [])


test_versions()
