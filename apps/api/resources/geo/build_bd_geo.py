import json, re, sys
src, out = sys.argv[1], sys.argv[2]

def load(n):
    for x in json.load(open(f"{src}/{n}.json", encoding="utf-8")):
        if x.get("type") == "table":
            return x["data"]

def slug(s):
    s = s.lower().replace("'", "").replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")

def clean(s):
    return re.sub(r"\s+", " ", s).strip()

dv, ds, up = load("divisions"), load("districts"), load("upazilas")
div_code = {d["id"]: slug(d["name"]) for d in dv}
dist_code = {d["id"]: slug(d["name"]) for d in ds}

divisions = sorted(({"code": div_code[d["id"]], "name": clean(d["name"]), "name_bn": clean(d["bn_name"])} for d in dv), key=lambda x: x["name"])
districts = sorted(({"code": dist_code[d["id"]], "division_code": div_code[d["division_id"]], "name": clean(d["name"]), "name_bn": clean(d["bn_name"])} for d in ds), key=lambda x: x["name"])

thanas, seen = [], set()
for u in up:
    dc = dist_code[u["district_id"]]
    code = f"{dc}-{slug(u['name'])}"
    if code in seen:
        raise SystemExit(f"duplicate {code}")
    seen.add(code)
    thanas.append({"code": code, "district_code": dc, "name": clean(u["name"]), "name_bn": clean(u["bn_name"]), "is_city": False})

# Hand-added metropolitan police thanas (P5-8 / Q37): Dhaka Metropolitan Police and Chattogram Metropolitan Police.
CITY = {
    "dhaka": [
        ("Adabor", "আদাবর"), ("Badda", "বাড্ডা"), ("Banani", "বনানী"), ("Bangshal", "বংশাল"), ("Bhashantek", "ভাসানটেক"),
        ("Bhatara", "ভাটারা"), ("Bimanbandar", "বিমানবন্দর"), ("Cantonment", "ক্যান্টনমেন্ট"), ("Chawkbazar", "চকবাজার"),
        ("Dakshinkhan", "দক্ষিণখান"), ("Darus Salam", "দারুস সালাম"), ("Demra", "ডেমরা"), ("Dhanmondi", "ধানমন্ডি"),
        ("Gendaria", "গেন্ডারিয়া"), ("Gulshan", "গুলশান"), ("Hatirjheel", "হাতিরঝিল"), ("Hazaribagh", "হাজারীবাগ"),
        ("Jatrabari", "যাত্রাবাড়ী"), ("Kadamtali", "কদমতলী"), ("Kafrul", "কাফরুল"), ("Kalabagan", "কলাবাগান"),
        ("Kamrangirchar", "কামরাঙ্গীরচর"), ("Khilgaon", "খিলগাঁও"), ("Khilkhet", "খিলক্ষেত"), ("Kotwali", "কোতোয়ালী"),
        ("Lalbagh", "লালবাগ"), ("Mirpur", "মিরপুর"), ("Mohammadpur", "মোহাম্মদপুর"), ("Motijheel", "মতিঝিল"),
        ("Mugda", "মুগদা"), ("New Market", "নিউ মার্কেট"), ("Pallabi", "পল্লবী"), ("Paltan", "পল্টন"), ("Ramna", "রমনা"),
        ("Rampura", "রামপুরা"), ("Rupnagar", "রূপনগর"), ("Sabujbagh", "সবুজবাগ"), ("Shah Ali", "শাহ আলী"),
        ("Shahbagh", "শাহবাগ"), ("Shahjahanpur", "শাহজাহানপুর"), ("Sher-e-Bangla Nagar", "শেরেবাংলা নগর"),
        ("Shyampur", "শ্যামপুর"), ("Sutrapur", "সূত্রাপুর"), ("Tejgaon", "তেজগাঁও"),
        ("Tejgaon Industrial Area", "তেজগাঁও শিল্পাঞ্চল"), ("Turag", "তুরাগ"), ("Uttara East", "উত্তরা পূর্ব"),
        ("Uttara West", "উত্তরা পশ্চিম"), ("Uttarkhan", "উত্তরখান"), ("Wari", "ওয়ারী"),
    ],
    "chattogram": [
        ("Akbar Shah", "আকবর শাহ"), ("Bakalia", "বাকলিয়া"), ("Bandar", "বন্দর"), ("Bayazid Bostami", "বায়েজিদ বোস্তামী"),
        ("Chandgaon", "চান্দগাঁও"), ("Chawkbazar", "চকবাজার"), ("Double Mooring", "ডবলমুরিং"), ("EPZ", "ইপিজেড"),
        ("Halishahar", "হালিশহর"), ("Khulshi", "খুলশী"), ("Kotwali", "কোতোয়ালী"), ("Pahartali", "পাহাড়তলী"),
        ("Panchlaish", "পাঁচলাইশ"), ("Patenga", "পতেঙ্গা"), ("Sadarghat", "সদরঘাট"), ("Karnaphuli", "কর্ণফুলী"),
    ],
}
for dc, rows in CITY.items():
    assert dc in dist_code.values(), dc
    for name, bn in rows:
        code = f"{dc}-{slug(name)}"
        if code in seen:
            for t in thanas:
                if t["code"] == code:
                    t["is_city"] = True
            continue
        seen.add(code)
        thanas.append({"code": code, "district_code": dc, "name": name, "name_bn": bn, "is_city": True})

assert all(len(t["code"]) <= 48 for t in thanas)
assert all(len(d["code"]) <= 32 for d in districts)
order = {d["code"]: d["name"] for d in districts}
thanas.sort(key=lambda t: (order[t["district_code"]], not t["is_city"], t["name"]))
doc = {"version": "2026.11.1", "divisions": divisions, "districts": districts, "thanas": thanas}
json.dump(doc, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=None, separators=(",", ":"))
print(len(divisions), len(districts), len(thanas), sum(t["is_city"] for t in thanas))
