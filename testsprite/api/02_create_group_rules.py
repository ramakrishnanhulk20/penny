import os
import requests
BASE_URL = os.environ.get("PENNY_BASE_URL", "https://penny-self.vercel.app").rstrip("/")

TOKEN_ALPHABET = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")


def expect(label, got, wanted):
    assert got == wanted, f"{label}: expected {wanted!r}, got {got!r}"


def expect_status(label, response, wanted):
    assert response.status_code == wanted, f"{label}: expected {wanted}, got {response.status_code} {response.text}"


def create(body):
    return requests.post(
        f"{BASE_URL}/api/groups", json=body, headers={"Content-Type": "application/json"}, timeout=30
    )


def expect_refusal(label, body, code):
    response = create(body)
    expect_status(label, response, 400)
    expect(label, response.json(), {"error": {"code": code}})


def test_create_group_rules() -> None:
    """A valid group is created as sent, and each broken create gets its own exact refusal."""
    response = create({"name": "API suite: create rules", "baseCurrency": "EUR", "members": ["Chen", "Asha", "Ben"]})
    expect_status("valid create", response, 201)
    body = response.json()
    expect("valid create keys", sorted(body), ["group", "token"])
    token = body["token"]
    # 16 random bytes in base64url without padding is always 22 characters from this alphabet.
    expect("token length", len(token), 22)
    expect("token characters outside A-Z a-z 0-9 _ -", sorted(set(token) - TOKEN_ALPHABET), [])
    group = body["group"]
    expect("name", group["name"], "API suite: create rules")
    expect("base currency", group["baseCurrency"], "EUR")
    # Members keep the order they were sent in, not alphabetical order.
    expect("member order", [member["name"] for member in group["members"]], ["Chen", "Asha", "Ben"])

    expect_refusal("one member", {"name": "One", "baseCurrency": "EUR", "members": ["Asha"]}, "too_few_members")
    twenty_one = [f"Member {n}" for n in range(1, 22)]
    expect_refusal("21 members", {"name": "Crowd", "baseCurrency": "EUR", "members": twenty_one}, "too_many_members")
    expect_refusal(
        "same name twice", {"name": "Twins", "baseCurrency": "EUR", "members": ["Asha", "Asha"]}, "duplicate_member_name"
    )
    expect_refusal("currency XYZ", {"name": "Odd", "baseCurrency": "XYZ", "members": ["Asha", "Ben"]}, "bad_currency")
    expect_refusal(
        "extra field",
        {"name": "Extra", "baseCurrency": "EUR", "members": ["Asha", "Ben"], "admin": True},
        "invalid_body",
    )

    plain = requests.post(
        f"{BASE_URL}/api/groups",
        data='{"name": "Plain", "baseCurrency": "EUR", "members": ["Asha", "Ben"]}',
        headers={"Content-Type": "text/plain"},
        timeout=30,
    )
    expect_status("text/plain", plain, 415)
    expect("text/plain", plain.json(), {"error": {"code": "unsupported_media_type"}})


test_create_group_rules()
