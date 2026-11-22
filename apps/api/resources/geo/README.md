# Bangladesh geography dataset (`bd.json`)

Served by `GET /api/v1/geo/bd` (PHASE-5-CONTRACT P5-10) and used by `App\Domain\Geo\BdGeo` for address validation and
shipping zones. Codes are stable, lowercase and never reused: addresses and zone areas store them.

| Field | Value |
|---|---|
| Version | `2026.11.1` (bump on every change; it is the HTTP `ETag`) |
| Divisions / districts / upazilas | [nuhil/bangladesh-geocode](https://github.com/nuhil/bangladesh-geocode), commit `c4b950b5cd2a65d42d75b12f7fad459e12777df6` (2026-11-12): `divisions/divisions.json`, `districts/districts.json`, `upazilas/upazilas.json` |
| Licence | MIT, © 2014 Nuhil Mehdy (verified in the repository's `LICENSE` file and GitHub licence metadata on 2026-11-22) |
| Hand-added | 50 Dhaka Metropolitan Police thanas (district `dhaka`) and 16 Chattogram Metropolitan Police thanas (district `chattogram`), `is_city: true` (Q37: "Inside Dhaka" = the Dhaka city thanas). English and Bangla names written by the API agent from the DMP/CMP thana lists |

Code rules:
- division / district: slug of the English name (`chattogram`, `coxs-bazar`).
- thana / upazila: `{district_code}-{slug(name)}` (`dhaka-dhanmondi`, `dhaka-savar`), at most 48 characters.

The upstream dataset lists only the 5 rural upazilas of Dhaka district (Savar, Dhamrai, Keraniganj, Nawabganj, Dohar),
which is why the metropolitan thanas are added by hand. Courier area mapping (Pathao/RedX/Steadfast area ids) is 5b.

Regenerate: `python3 -I build_bd_geo.py <dir with the three upstream JSON files> bd.json`, then bump `version` and check
that no existing code changed (codes are referenced by orders, zones and pickup locations).
