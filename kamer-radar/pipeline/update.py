"""Kamer-radar: haalt dagelijks VWS-zaken uit de open data van de Tweede Kamer.

Bron: het Gegevensmagazijn (OData v4) van de Tweede Kamer, zonder sleutel.
Schrijft kamer-radar/data/radar.json met vier onderdelen:
  vragen        schriftelijke Kamervragen aan VWS-bewindspersonen (+ mondiale onderwerpen)
  brieven       Kamerbrieven van VWS (+ mondiale onderwerpen), met de stand van een schriftelijk overleg
  moties        moties in VWS-dossiers (+ mondiale onderwerpen), met stemuitslag
  toezeggingen  openstaande en recent afgedane toezeggingen van VWS
  agenda        commissie- en plenaire activiteiten over VWS-zaken
  debatten      alle debatten waar VWS direct bij betrokken is (laatste drie maanden + komende), met aantal moties/toezeggingen
Een jaar terug (vragen, brieven, agenda) staat in kamer-radar/data/jaar.json; de pagina laadt dat
pas bij terugkijken of zoeken.

Alleen standaardbibliotheek. Faalt zonder iets te overschrijven als een onderdeel leeg terugkomt.
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0/"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "radar.json")
ARCHIEF = os.path.join(HERE, "..", "data", "jaar.json")

TODAY = dt.date.today()
VRAGEN_DAGEN = 120      # vragen van de afgelopen vier maanden (hoofdbestand)
ARCHIEF_DAGEN = 366     # terugkijken: vragen, brieven en agenda van het afgelopen jaar (data/jaar.json)
MOTIES_DAGEN = 60       # moties van de afgelopen twee maanden
AFGEDAAN_DAGEN = 60     # afgedane toezeggingen nog even laten zien
AGENDA_TERUG, AGENDA_VOORUIT = 14, 150
DEBATTEN_TERUG = 92     # debatten van de afgelopen drie maanden (tab Debatten)

# Bewindspersonen van VWS herkennen aan hun functie (namen wisselen per kabinet).
VWS_FUNCTIE = re.compile(r"Volksgezondheid|Langdurige|Jeugd, Preventie|Maatschappelijke Zorg", re.I)
VWS_MINISTERIE = "Volksgezondheid, Welzijn en Sport"

# Mondiale gezondheid: ook meenemen als het niet bij VWS ligt (bv. BHO of BZ).
MONDIAAL = re.compile(
    r"\bWHO\b|Wereldgezondheid|mondiale gezondheid|global health|pandemi|\bIHR\b|"
    r"Internationale Gezondheidsregeling|antimicrobi|antibioticaresist|ebola|mpox|"
    r"marburg|cholera|polio|malaria|tubercul|\bhiv\b|UNAIDS|Gavi|Global Fund|CEPI|"
    r"vogelgriep|zoön|one health|\bECDC\b|\bHERA\b|EU-Gezondheidsraad|uitbraak",
    re.I)


def get(entity, params, limit=None):
    """Alle pagina's van een OData-query (max 250 per pagina)."""
    out, skip = [], 0
    while True:
        q = dict(params, **{"$top": "250", "$skip": str(skip)})
        url = API + entity + "?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    data = json.load(r)
                break
            except Exception as e:  # netwerkhik: even wachten en opnieuw
                if attempt == 3:
                    raise
                print(f"  opnieuw ({e})", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
        out += data["value"]
        if len(data["value"]) < 250 or (limit and len(out) >= limit):
            return out
        skip += 250


def d(s):
    """ISO-datum (yyyy-mm-dd) of None; '0001-01-01' betekent 'geen'."""
    if not s or s.startswith("0001"):
        return None
    return s[:10]


def iso(n_days):
    return (TODAY + dt.timedelta(days=n_days)).isoformat()


def personen(actors, rollen):
    sel = [a for a in actors if a.get("Relatie") in rollen and not a.get("Verwijderd")]
    sel.sort(key=lambda a: rollen.index(a["Relatie"]))  # indiener eerst
    return [{"naam": a.get("ActorNaam"), "fractie": a.get("ActorFractie")} for a in sel]


def kort_functie(f):
    if not f:
        return ""
    f = f[0].upper() + f[1:]
    return (f.replace("Volksgezondheid, Welzijn en Sport", "VWS")
             .replace("Buitenlandse Handel en Ontwikkelingshulp", "BHO")
             .replace("Buitenlandse Handel en Ontwikkelingssamenwerking", "BHO"))


# ---------------------------------------------------------------- Kamervragen
def vragen(dagen=ARCHIEF_DAGEN):
    rows = get("Zaak", {
        "$filter": f"Soort eq 'Schriftelijke vragen' and Verwijderd eq false and GestartOp ge {iso(-dagen)}",
        "$select": "Id,Nummer,Onderwerp,GestartOp,Afgedaan",
        "$orderby": "GestartOp desc",
        "$expand": "ZaakActor($select=ActorNaam,ActorFractie,Functie,Relatie,Verwijderd),"
                   "Document($select=Soort,DocumentNummer,Datum,Verwijderd)",
    })
    res = []
    for z in rows:
        gericht = [a for a in z["ZaakActor"] if a["Relatie"] == "Gericht aan" and not a["Verwijderd"]]
        vws = any(VWS_FUNCTIE.search(a.get("Functie") or "") for a in gericht)
        mondiaal = bool(MONDIAAL.search(z["Onderwerp"] or ""))
        if not (vws or mondiaal):
            continue
        docs = [x for x in z["Document"] if not x["Verwijderd"]]
        vraagdoc = next((x for x in docs if x["Soort"] == "Schriftelijke vragen"), None)
        antw = sorted((x for x in docs if x["Soort"].startswith("Antwoord schriftelijke vragen")),
                      key=lambda x: x["Datum"] or "")
        uitstel = sorted((x for x in docs if "uitstel" in x["Soort"].lower()), key=lambda x: x["Datum"] or "")
        start = d(z["GestartOp"])
        termijn = (dt.date.fromisoformat(start) + dt.timedelta(days=21)).isoformat() if start else None
        if antw:
            status = "beantwoord"
        elif uitstel:
            status = "uitstel"
        else:
            status = "open"
        res.append({
            "nr": z["Nummer"],
            "did": vraagdoc["DocumentNummer"] if vraagdoc else None,
            "onderwerp": (z["Onderwerp"] or "").strip(),
            "datum": start,
            "termijn": termijn,
            "status": status,
            "antwoord": d(antw[-1]["Datum"]) if antw else None,
            "antwoordDid": antw[-1]["DocumentNummer"] if antw else None,
            "uitstel": d(uitstel[-1]["Datum"]) if uitstel else None,
            "indieners": personen(z["ZaakActor"], ("Indiener", "Medeindiener")),
            "gericht": sorted({kort_functie(a.get("Functie")) for a in gericht if a.get("Functie")}),
            "vws": vws,
            "mondiaal": mondiaal,
        })
    return res


# ---------------------------------------------------------------- VWS-dossiers
GENERIEK = re.compile(r"Nota over de toestand|Voorjaarsnota|Najaarsnota|Kabinetsformatie|NAVO|"
                      r"begrotingsstaten|Jaarverslag en slotwet", re.I)
EIGEN_DOSSIER = re.compile(r"^(Wijziging|Voorstel van wet|Goedkeuring|Regels|Initiatiefnota|Evaluatie)", re.I)


def vws_dossiers():
    """Kamerstukdossiers waarin VWS de voortouwcommissie heeft (sinds 2024)."""
    zaken = get("Zaak", {
        "$filter": "Verwijderd eq false and GestartOp ge 2024-01-01 and "
                   "ZaakActor/any(a: a/Relatie eq 'Voortouwcommissie' and a/ActorAfkorting eq 'VWS')",
        "$select": "Id",
        "$expand": "Kamerstukdossier($select=Nummer,Toevoeging,Titel)",
    })
    tel, titel = {}, {}
    for z in zaken:
        for k in z["Kamerstukdossier"]:
            key = (k["Nummer"], k["Toevoeging"] or "")
            tel[key] = tel.get(key, 0) + 1
            titel[key] = k["Titel"] or ""
    keep, kandidaten = set(), []
    for key, n in tel.items():
        t = titel[key]
        if key[1] == "XVI":                      # VWS-begroting en suppletoire wetten
            keep.add(key)
        elif GENERIEK.search(t):
            continue
        elif n >= 2 or EIGEN_DOSSIER.search(t):
            kandidaten.append(key)

    # Gedeelde dossiers (bv. Passend onderwijs, ICT) eruit: VWS moet een flink deel trekken.
    def aandeel(key):
        toev = "null" if not key[1] else "'" + key[1].replace("'", "''") + "'"
        url = API + "Zaak?" + urllib.parse.urlencode({
            "$filter": f"Verwijderd eq false and GestartOp ge 2024-01-01 and "
                       f"Kamerstukdossier/any(k: k/Nummer eq {key[0]} and k/Toevoeging eq {toev})",
            "$count": "true", "$top": "0"}, quote_via=urllib.parse.quote)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    totaal = json.load(r)["@odata.count"]
                return key, tel[key] / max(totaal, 1)
            except Exception:
                time.sleep(3)
        return key, 1.0  # bij twijfel houden
    with ThreadPoolExecutor(max_workers=6) as ex:
        for key, share in ex.map(aandeel, kandidaten):
            if share >= 0.2:
                keep.add(key)
    return keep


# ---------------------------------------------------------------- Moties
UITSLAG = {
    "Stemmen - aangenomen": "aangenomen",
    "Stemmen - verworpen": "verworpen",
    "Stemmen - aangehouden": "aangehouden",
    "Stemmen - aangehouden (al tijdens debat)": "aangehouden",
    "Stemmen - ingetrokken": "ingetrokken",
    "Ingetrokken": "ingetrokken",
    "Stemmen - vervallen": "vervallen",
}


def motie_titel(s):
    """'Motie van het lid X c.s. over iets' -> 'iets'."""
    s = (s or "").strip()
    m = re.match(r"^(?:(?:Nader )?[Gg]ewijzigde )?[Mm]otie van (?:het lid|de leden) .+? over (.+)$", s)
    s = (m.group(1) if m else s).strip()
    return s[:1].upper() + s[1:]


def moties(dossiers):
    rows = get("Zaak", {
        "$filter": f"Soort eq 'Motie' and Verwijderd eq false and GestartOp ge {iso(-MOTIES_DAGEN)}",
        "$select": "Id,Nummer,Onderwerp,GestartOp,Kabinetsappreciatie",
        "$orderby": "GestartOp desc",
        "$expand": "ZaakActor($select=ActorNaam,ActorFractie,Relatie,Verwijderd),"
                   "Document($select=DocumentNummer,Soort,Verwijderd;$expand=Kamerstukdossier($select=Nummer,Toevoeging,Titel)),"
                   "Agendapunt($select=Id,Verwijderd;$expand=Activiteit($select=Nummer,Soort,Datum,Onderwerp)),"
                   "Besluit($select=BesluitSoort,StemmingsSoort,Status,Verwijderd;"
                   "$expand=Agendapunt($select=Id;$expand=Activiteit($select=Datum,Soort)),"
                   "Stemming($select=Soort,ActorFractie,FractieGrootte,Verwijderd))",
    })
    res = []
    for z in rows:
        docs = [x for x in z["Document"] if not x["Verwijderd"]]
        ksd = [k for x in docs for k in x["Kamerstukdossier"]]
        vws = any((k["Nummer"], k["Toevoeging"] or "") in dossiers for k in ksd)
        mondiaal = bool(MONDIAAL.search(z["Onderwerp"] or ""))
        if not (vws or mondiaal):
            continue
        doc = next((x for x in docs if x["Soort"] and "otie" in x["Soort"]), docs[0] if docs else None)

        # Uitslag: het laatste besluit met een echte uitkomst
        uitslag, stemdatum, soort, voor, tegen = "ingediend", None, None, [], []
        best = None
        for b in z["Besluit"]:
            if b["Verwijderd"] or b["BesluitSoort"] not in UITSLAG:
                continue
            datum = ((b.get("Agendapunt") or {}).get("Activiteit") or {}).get("Datum") or ""
            if best is None or datum >= best[0]:
                best = (datum, b)
        if best:
            b = best[1]
            uitslag, stemdatum, soort = UITSLAG[b["BesluitSoort"]], d(best[0]), b["StemmingsSoort"]
            perfractie = {}
            for s in b["Stemming"]:
                if s["Verwijderd"] or not s["ActorFractie"]:
                    continue
                n = s["FractieGrootte"] if soort == "Met handopsteken" else 1
                f = perfractie.setdefault(s["ActorFractie"], {"Voor": 0, "Tegen": 0, "n": s["FractieGrootte"] or 0})
                if s["Soort"] in ("Voor", "Tegen"):
                    f[s["Soort"]] += n or 0
            for f, v in sorted(perfractie.items(), key=lambda x: -x[1]["n"]):
                if v["Voor"]:
                    voor.append([f, v["Voor"]])
                if v["Tegen"]:
                    tegen.append([f, v["Tegen"]])

        # Nog in stemming: agendapunt in een stemmingenactiviteit vandaag of later
        gepland = None
        if uitslag == "ingediend":
            for p in z["Agendapunt"]:
                a = p.get("Activiteit") or {}
                if not p["Verwijderd"] and a.get("Soort") == "Stemmingen" and d(a.get("Datum")) and d(a["Datum"]) >= TODAY.isoformat():
                    gepland = min(filter(None, [gepland, d(a["Datum"])]))
        deb = next((p["Activiteit"] for p in z["Agendapunt"]
                    if p.get("Activiteit") and p["Activiteit"].get("Soort") != "Stemmingen"), None)
        debat = deb["Onderwerp"] if deb else None

        k = ksd[0] if ksd else None
        res.append({
            "nr": z["Nummer"],
            "did": doc["DocumentNummer"] if doc else None,
            "onderwerp": motie_titel(z["Onderwerp"]),
            "volledig": (z["Onderwerp"] or "").strip(),
            "datum": d(z["GestartOp"]),
            "indieners": personen(z["ZaakActor"], ("Indiener", "Medeindiener")),
            "dossier": {"nr": k["Nummer"], "toev": k["Toevoeging"], "titel": k["Titel"]} if k else None,
            "debat": debat,
            "debatNr": deb.get("Nummer") if deb else None,
            "appreciatie": z["Kabinetsappreciatie"] if z["Kabinetsappreciatie"] not in (None, "Niet ingevuld") else None,
            "uitslag": uitslag,
            "stemdatum": stemdatum,
            "stemming": soort,
            "gepland": gepland,
            "voor": voor,
            "tegen": tegen,
            "vws": vws,
            "mondiaal": mondiaal,
        })
    return res


# ---------------------------------------------------------------- Toezeggingen
def toezeggingen():
    rows = get("Toezegging", {
        "$filter": f"Verwijderd eq false and Ministerie eq '{VWS_MINISTERIE}' and "
                   f"(Status eq 'Openstaand' or Status eq 'Deels Afgedaan' or "
                   f"(Status eq 'Afgedaan' and GewijzigdOp ge {iso(-AFGEDAAN_DAGEN)}))",
        "$select": "Nummer,Tekst,Naam,Functie,Status,DatumNakoming,Aanmaakdatum,GewijzigdOp,ActiviteitNummer",
        "$orderby": "Aanmaakdatum desc",
        "$expand": "Activiteit($select=Nummer,Onderwerp,Datum,Soort)",
    })
    res = []
    for t in rows:
        acts = sorted(t.get("Activiteit") or [], key=lambda a: a.get("Datum") or "")
        a = acts[0] if acts else None
        naam = re.sub(r"\s+", " ", (t["Naam"] or "").replace(",,", ",")).strip(" ,")
        res.append({
            "nr": t["Nummer"],
            "tekst": re.sub(r"\s+", " ", t["Tekst"] or "").strip(),
            "wie": naam,
            "functie": kort_functie(t["Functie"]),
            "status": t["Status"],
            "deadline": d(t["DatumNakoming"]),
            "datum": d(t["Aanmaakdatum"]),
            "gewijzigd": d(t["GewijzigdOp"]),
            "debat": {"nr": a["Nummer"], "onderwerp": a["Onderwerp"], "datum": d(a["Datum"]), "soort": a["Soort"]} if a else None,
            "mondiaal": bool(MONDIAAL.search(t["Tekst"] or "")),
        })
    return res


# ---------------------------------------------------------------- Agenda
SKIP_SOORT = {"Petitie", "Reservering", "Werkbezoek"}


# ---------------------------------------------------------------- Kamerbrieven + schriftelijk overleg
KAMERSTUK_REF = re.compile(r"\(Kamerstuk(?:ken)? (\d+)(?:-([A-Z0-9]+))?-(\d+)\)")
MONDIAAL_ZOEK = ["WHO", "Wereldgezondheid", "pandemi", "mondiale gezondheid", "Gezondheidsregeling",
                 "antimicrobi", "antibiotica", "Gavi", "Global Fund", "UNAIDS", "CEPI", "ebola", "mpox"]


def norm(s):
    return re.sub(r"\W+", " ", (s or "").lower()).strip()


def brieven(agenda_items, dagen=ARCHIEF_DAGEN):
    exp = ("Document($select=Soort,DocumentNummer,Datum,Volgnummer,Verwijderd;"
           "$expand=Kamerstukdossier($select=Nummer,Toevoeging,Titel)),"
           "Kamerstukdossier($select=Nummer,Toevoeging,Titel)")
    sel = "Id,Nummer,Onderwerp,GestartOp"
    basis = f"Verwijderd eq false and Soort eq 'Brief regering' and GestartOp ge {iso(-dagen)}"
    rows = get("Zaak", {"$filter": basis + " and ZaakActor/any(a: a/Relatie eq 'Voortouwcommissie' and a/ActorAfkorting eq 'VWS')",
                        "$select": sel, "$expand": exp, "$orderby": "GestartOp desc"})
    vws_ids = {z["Id"] for z in rows}
    kw = " or ".join(f"contains(Onderwerp,'{k}')" for k in MONDIAAL_ZOEK)
    extra = get("Zaak", {"$filter": f"{basis} and ({kw})", "$select": sel, "$expand": exp})
    rows += [z for z in extra if z["Id"] not in vws_ids and MONDIAAL.search(z["Onderwerp"] or "")]

    # Inbrengdata van schriftelijke overleggen uit de agenda (ook toekomstige), op onderwerp
    so_datum = {}
    for a in agenda_items:
        if a["soort"] == "Inbreng schriftelijk overleg":
            so_datum.setdefault(norm(a["onderwerp"]), []).append((a["datum"], a["nr"]))

    res, per_kamerstuk = [], {}
    for z in rows:
        docs = [x for x in z["Document"] if not x["Verwijderd"]]
        brief = next((x for x in docs if x["Soort"] == "Brief regering"), docs[0] if docs else None)
        k = (brief or {}).get("Kamerstukdossier") or z["Kamerstukdossier"]
        k = k[0] if k else None
        kamerstuk = None
        if k and brief and brief.get("Volgnummer"):
            kamerstuk = f"{k['Nummer']}{'-' + k['Toevoeging'] if k['Toevoeging'] else ''}-{brief['Volgnummer']}"
        inbreng = sorted((x for x in docs if x["Soort"] == "Inbreng verslag schriftelijk overleg"), key=lambda x: x["Datum"] or "")
        verslag = sorted((x for x in docs if x["Soort"] == "Verslag van een schriftelijk overleg"), key=lambda x: x["Datum"] or "")
        onderwerp = re.sub(r"\s+", " ", z["Onderwerp"] or "").strip()
        geplande = [x for x in so_datum.get(norm(onderwerp), [])]
        ref = KAMERSTUK_REF.search(onderwerp)
        item = {
            "nr": z["Nummer"],
            "did": brief["DocumentNummer"] if brief else None,
            "onderwerp": onderwerp,
            "datum": d(z["GestartOp"]),
            "dossier": {"nr": k["Nummer"], "toev": k["Toevoeging"], "titel": k["Titel"]} if k else None,
            "kamerstuk": kamerstuk,
            "inbreng": d(inbreng[-1]["Datum"]) if inbreng else (max(g[0] for g in geplande) if geplande else None),
            "inbrengDid": inbreng[-1]["DocumentNummer"] if inbreng else None,
            "inbrengAct": max(geplande)[1] if geplande else None,
            "antwoord": d(verslag[-1]["Datum"]) if verslag else None,
            "antwoordNr": z["Nummer"] if verslag else None,
            "antwoordDid": verslag[-1]["DocumentNummer"] if verslag else None,
            # Antwoorden op een SO komen vaak als aparte brief "Antwoorden op vragen commissie over … (Kamerstuk x-y)"
            "antwoordOp": "-".join(filter(None, ref.groups())) if ref and onderwerp.lower().startswith("antwoorden op vragen") else None,
            "vws": z["Id"] in vws_ids,
            "mondiaal": bool(MONDIAAL.search(onderwerp)),
        }
        res.append(item)
        if kamerstuk:
            per_kamerstuk[kamerstuk] = item
    # Koppel losse antwoordbrieven aan de oorspronkelijke brief
    for b in res:
        if b["antwoordOp"] and b["antwoordOp"] in per_kamerstuk:
            o = per_kamerstuk[b["antwoordOp"]]
            if not o["antwoord"] or (b["datum"] or "") > o["antwoord"]:
                o["antwoord"], o["antwoordNr"], o["antwoordDid"] = b["datum"], b["nr"], b["did"]
    for b in res:
        if b["antwoord"]:
            b["so"] = "beantwoord"
        elif b["inbreng"] and b["inbreng"] < TODAY.isoformat():
            b["so"] = "wacht"           # Kamer heeft vragen gesteld, kabinet moet nog antwoorden
        elif b["inbreng"]:
            b["so"] = "gepland"         # inbrengdatum ligt nog in de toekomst
        else:
            b["so"] = None
    res.sort(key=lambda b: (b["datum"] or "", b["nr"]), reverse=True)
    return res


def agenda(terug=ARCHIEF_DAGEN):
    sel = "Id,Nummer,Soort,Onderwerp,Datum,Aanvangstijd,Eindtijd,Status,Besloten,DatumSoort,Locatie,Noot,Voortouwafkorting"
    van, tot = iso(-terug), iso(AGENDA_VOORUIT)
    commissie = get("Activiteit", {
        "$filter": f"Verwijderd eq false and Datum ge {van} and Datum lt {tot} and Voortouwafkorting eq 'VWS'",
        "$select": sel, "$orderby": "Datum",
    })
    vt = "ZaakActor($select=ActorAfkorting;$filter=Relatie eq 'Voortouwcommissie')"
    plenair_alle = get("Activiteit", {
        "$filter": f"Verwijderd eq false and Datum ge {van} and Datum lt {tot} and startswith(Soort,'Plenair')",
        "$select": sel, "$orderby": "Datum",
        "$expand": f"Zaak($select=Id;$expand={vt}),Agendapunt($select=Id;$expand=Zaak($select=Id;$expand={vt}))",
    })
    plenair = []
    for a in plenair_alle:
        zaken = list(a["Zaak"]) + [z for p in a["Agendapunt"] for z in p["Zaak"]]
        # Voortouw per zaak, zonder 'TK' (plenair). Een begroting van een ander ministerie met
        # één VWS-zaakje erin telt niet: minstens de helft van de zaken moet VWS zijn.
        sets = [s for s in ({x["ActorAfkorting"] for x in z["ZaakActor"]} - {"TK", None} for z in zaken) if s]
        vws = sum("VWS" in s for s in sets)
        if (sets and vws / len(sets) >= 0.5) or MONDIAAL.search(a["Onderwerp"] or ""):
            plenair.append(a)
    res = []
    for a in commissie + plenair:
        if a["Soort"] in SKIP_SOORT:
            continue
        tijd = a["Aanvangstijd"][11:16] if a.get("Aanvangstijd") else None
        res.append({
            "nr": a["Nummer"],
            "soort": a["Soort"],
            "onderwerp": re.sub(r"\s+", " ", a["Onderwerp"] or "").strip(),
            "datum": d(a["Datum"]),
            "tijd": tijd if a.get("DatumSoort") == "Dag" else None,
            "eind": a["Eindtijd"][11:16] if a.get("Eindtijd") and a.get("DatumSoort") == "Dag" else None,
            "week": a.get("DatumSoort") == "Weeknummer",
            "status": a["Status"],
            "besloten": bool(a["Besloten"]),
            "locatie": a.get("Locatie"),
            "plenair": a["Soort"].startswith("Plenair"),
            "mondiaal": bool(MONDIAAL.search(a["Onderwerp"] or "")),
        })
    res.sort(key=lambda x: (x["datum"] or "", x["tijd"] or "99"))
    return res


def debat_status(onderwerp, status):
    """De Kamer zet 'geannuleerd' of 'uitgesteld' soms alleen in de titel, terwijl de status Uitgevoerd blijft."""
    if re.search(r"geannuleerd", onderwerp, re.I):
        return "Geannuleerd"
    if re.search(r"uitgesteld|verplaatst", onderwerp, re.I) and status != "Geannuleerd":
        return "Verplaatst"
    return status


def debatten(terug=DEBATTEN_TERUG):
    """Alle debatten waar VWS direct bij betrokken is: VWS heeft het voortouw, een VWS-bewindspersoon
    doet mee (ook bij debatten van andere commissies, tweeminutendebatten, begroting, vragenuur),
    of bij plenaire debatten hoort minstens de helft van de zaken bij VWS. Geen overleggen,
    briefings of procedures."""
    sel = "Id,Nummer,Soort,Onderwerp,Datum,Aanvangstijd,Eindtijd,Status,Besloten,DatumSoort,Locatie,Voortouwafkorting"
    van, tot = iso(-terug), iso(AGENDA_VOORUIT)
    basis = f"Verwijderd eq false and Datum ge {van} and Datum lt {tot}"
    actor = "ActiviteitActor($select=Relatie,Functie,ActorNaam,Verwijderd)"
    commissie = get("Activiteit", {
        "$filter": basis + " and (Soort eq 'Commissiedebat' or Soort eq 'Wetgevingsoverleg' or Soort eq 'Notaoverleg' or Soort eq 'Vragenuur')",
        "$select": sel, "$orderby": "Datum", "$expand": actor,
    })
    vt = "ZaakActor($select=ActorAfkorting;$filter=Relatie eq 'Voortouwcommissie')"
    plenair = get("Activiteit", {
        "$filter": basis + " and startswith(Soort,'Plenair debat')",
        "$select": sel, "$orderby": "Datum",
        "$expand": f"{actor},Zaak($select=Id;$expand={vt}),Agendapunt($select=Id;$expand=Zaak($select=Id;$expand={vt}))",
    })
    res = []
    for a in commissie + plenair:
        mins = []
        for x in a["ActiviteitActor"]:
            if (not x.get("Verwijderd") and x["Relatie"] == "Bewindspersoon c.a."
                    and VWS_FUNCTIE.search(x["Functie"] or "") and x["ActorNaam"] not in mins):
                mins.append(x["ActorNaam"])
        voortouw = a.get("Voortouwafkorting")
        via = None
        if voortouw == "VWS":
            via = "voortouw"
        elif mins:
            via = "bewindspersoon"
        elif a["Soort"].startswith("Plenair"):
            zaken = list(a["Zaak"]) + [z for p in a["Agendapunt"] for z in p["Zaak"]]
            sets = [s for s in ({x["ActorAfkorting"] for x in z["ZaakActor"]} - {"TK", None} for z in zaken) if s]
            if sets and sum("VWS" in s for s in sets) / len(sets) >= 0.5:
                via = "zaken"
        if not via and MONDIAAL.search(a["Onderwerp"] or ""):
            via = "onderwerp"
        if not via:
            continue
        onderwerp = re.sub(r"\s+", " ", a["Onderwerp"] or "").strip()
        dag = a.get("DatumSoort") == "Dag"
        res.append({
            "nr": a["Nummer"],
            "soort": a["Soort"],
            "onderwerp": onderwerp,
            "datum": d(a["Datum"]),
            "tijd": a["Aanvangstijd"][11:16] if a.get("Aanvangstijd") and dag else None,
            "eind": a["Eindtijd"][11:16] if a.get("Eindtijd") and dag else None,
            "week": not dag,
            "status": debat_status(onderwerp, a["Status"]),
            "besloten": bool(a["Besloten"]),
            "plenair": a["Soort"].startswith("Plenair") or a["Soort"] == "Vragenuur",
            "commissie": voortouw if voortouw and voortouw != "TK" else None,
            "via": via,
            "bewindspersonen": mins,
            "mondiaal": bool(MONDIAAL.search(onderwerp)),
        })
    res.sort(key=lambda x: (x["datum"] or "", x["tijd"] or "99", x["nr"]))
    return res


def koppel_debatten(deb, moties_, toez):
    """Per debat: aantal moties (laatste twee maanden) en toezeggingen dat eruit voortkwam."""
    m, t = {}, {}
    for x in moties_:
        if x.get("debatNr"):
            m[x["debatNr"]] = m.get(x["debatNr"], 0) + 1
    for x in toez:
        if x.get("debat"):
            t[x["debat"]["nr"]] = t.get(x["debat"]["nr"], 0) + 1
    for a in deb:
        a["moties"] = m.get(a["nr"], 0)
        a["toezeggingen"] = t.get(a["nr"], 0)


def main():
    t0 = time.time()
    print("VWS-dossiers…")
    dossiers = vws_dossiers()
    print(f"  {len(dossiers)} dossiers")
    out = {"bijgewerkt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
           "bron": "Gegevensmagazijn Tweede Kamer (open data)"}
    for naam, fn in (("vragen", vragen), ("moties", lambda: moties(dossiers)),
                     ("toezeggingen", toezeggingen), ("agenda", agenda), ("debatten", debatten),
                     ("brieven", lambda: brieven(out["agenda"]))):
        print(naam + "…")
        out[naam] = fn()
        print(f"  {len(out[naam])}")
        if not out[naam]:
            sys.exit(f"Leeg resultaat voor {naam}; radar.json niet overschreven.")

    koppel_debatten(out["debatten"], out["moties"], out["toezeggingen"])

    # Het jaar gaat in een apart bestand, zodat de pagina snel opent; het hoofdbestand houdt
    # vier maanden vragen en brieven en de agenda vanaf twee weken terug.
    jaar = {"bijgewerkt": out["bijgewerkt"], "vanaf": iso(-ARCHIEF_DAGEN),
            "vragen": out["vragen"], "brieven": out["brieven"], "agenda": out["agenda"]}
    recent = iso(-VRAGEN_DAGEN)
    out["vragen"] = [v for v in out["vragen"] if (v["datum"] or "") >= recent]
    out["brieven"] = [b for b in out["brieven"] if (b["datum"] or "") >= recent or b["so"] in ("wacht", "gepland")]
    out["agenda"] = [a for a in out["agenda"] if (a["datum"] or "") >= iso(-AGENDA_TERUG)]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    with open(ARCHIEF, "w", encoding="utf-8") as f:
        json.dump(jaar, f, ensure_ascii=False, separators=(",", ":"))
    oud = os.path.join(os.path.dirname(OUT), "vragen-jaar.json")
    if os.path.exists(oud):
        os.remove(oud)
    print(f"Jaar: {len(jaar['vragen'])} vragen, {len(jaar['brieven'])} brieven, {len(jaar['agenda'])} activiteiten "
          f"sinds {jaar['vanaf']}, {os.path.getsize(ARCHIEF) // 1024} kB")
    print(f"Klaar in {time.time() - t0:.0f}s, {os.path.getsize(OUT) // 1024} kB")


if __name__ == "__main__":
    main()
