import copy
import json
import os

DB_PATH = os.environ.get("TEST_DB_PATH", "fixtures/demo-database.json")


def is_voided_transaction(transaction):
    return bool(
        transaction.get("status") == "voided"
        or transaction.get("voidedAt")
        or transaction.get("voided") is True
    )


def active_transactions(transactions):
    return [t for t in transactions if not is_voided_transaction(t)]


def month_code(month_str):
    year, month = [int(x) for x in month_str.split("/")]
    return year * 12 + month


def is_sub_active_in_month(sub, target_month):
    target = month_code(target_month)
    start = month_code(sub["startMonth"])
    exit_code = 999999
    if sub.get("exitMonth"):
        exit_code = month_code(sub["exitMonth"])
    return start <= target <= exit_code


def active_subscriptions_for(db, member_name, platform_name, target_month):
    return [
        sub
        for sub in db["subscriptions"]
        if sub["memberName"] == member_name
        and sub["platformName"] == platform_name
        and is_sub_active_in_month(sub, target_month)
    ]


def platform_price_for_month(db, platform, target_month):
    mode = platform.get("billingMode", "fixed")
    if mode != "split":
        return float(platform["price"])

    active_count = sum(
        1
        for sub in db["subscriptions"]
        if sub["platformName"] == platform["name"]
        and is_sub_active_in_month(sub, target_month)
    )
    return round(platform.get("totalCost", 0) / active_count) if active_count else 0


def get_member_monthly_fee(member, db, target_month):
    if member.get("customFee") is not None:
        return float(member["customFee"])

    total = 0
    for sub in db["subscriptions"]:
        if sub["memberName"] != member["name"] or not is_sub_active_in_month(sub, target_month):
            continue
        platform = next((p for p in db["platforms"] if p["name"] == sub["platformName"]), None)
        if platform:
            total += platform_price_for_month(db, platform, target_month)
    return total


def simulate_rollover(db):
    current_month = db["currentMonth"]
    year, month = [int(x) for x in current_month.split("/")]

    balances_report = []
    updated_members = []

    for member in db["members"]:
        prior = member["priorBalance"]
        fee = get_member_monthly_fee(member, db, current_month)
        temp = sum(
            charge["amount"]
            for charge in active_transactions(db["tempCharges"])
            if charge["memberName"] == member["name"]
        )
        paid = sum(
            payment["amount"]
            for payment in active_transactions(db["payments"])
            if payment["memberName"] == member["name"]
        )
        ending = prior + fee + temp - paid

        balances_report.append(
            {
                "memberId": member["id"],
                "memberName": member["name"],
                "priorBalance": prior,
                "subscriptionFee": fee,
                "tempCharge": temp,
                "paid": paid,
                "endingBalance": ending,
            }
        )
        updated_members.append({**member, "priorBalance": ending})

    db["history"].append(
        {
            "month": current_month,
            "balances": balances_report,
            "payments": list(db["payments"]),
            "tempCharges": list(db["tempCharges"]),
        }
    )

    next_month = month + 1
    next_year = year
    if next_month > 12:
        next_month = 1
        next_year += 1
    db["currentMonth"] = f"{next_year}/{next_month:02d}"
    db["members"] = updated_members
    db["payments"] = []
    db["tempCharges"] = []


def member(db, name):
    return next(m for m in db["members"] if m["name"] == name)


def main():
    with open(DB_PATH, "r", encoding="utf-8") as file:
        original = json.load(file)

    db = copy.deepcopy(original)
    original_history_count = len(db["history"])

    assert db["currentMonth"] == "2026/06"

    member_ids = {m["id"] for m in db["members"]}
    platform_ids = {p["id"] for p in db["platforms"]}
    for sub in db["subscriptions"]:
        assert sub.get("memberId") in member_ids
        assert sub.get("platformId") in platform_ids
    print("Stable ID relations: OK")

    gamma = member(db, "Member Gamma")
    assert get_member_monthly_fee(gamma, db, "2026/06") == 300

    beta = member(db, "Member Beta")
    beta_fee = get_member_monthly_fee(beta, db, "2026/06")
    beta_video_active = active_subscriptions_for(db, "Member Beta", "Shared Video", "2026/06")
    assert beta_fee == 280
    assert len(beta_video_active) == 2
    assert all(s.get("allowDuplicate") and s.get("seatLabel") for s in beta_video_active)

    expected_prior = {}
    for item in db["members"]:
        fee = get_member_monthly_fee(item, db, "2026/06")
        temp = sum(
            charge["amount"]
            for charge in active_transactions(db["tempCharges"])
            if charge["memberName"] == item["name"]
        )
        paid = sum(
            payment["amount"]
            for payment in active_transactions(db["payments"])
            if payment["memberName"] == item["name"]
        )
        expected_prior[item["name"]] = item["priorBalance"] + fee + temp - paid

    simulate_rollover(db)

    assert db["currentMonth"] == "2026/07"
    assert len(db["payments"]) == 0
    assert len(db["tempCharges"]) == 0
    assert len(db["history"]) == original_history_count + 1
    assert db["history"][-1]["month"] == "2026/06"

    for name, expected in expected_prior.items():
        assert member(db, name)["priorBalance"] == expected

    assert get_member_monthly_fee(member(db, "Member Beta"), db, "2026/07") == 280
    print("Rollover integration tests passed.")


if __name__ == "__main__":
    main()
