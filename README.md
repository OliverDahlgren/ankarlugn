# Ankarlugn

Statisk webbsida som hjälper dig hitta natthamn, ankringsplats eller badvik med bäst lä i Stockholms skärgård.
Du anger ankomst och avfärd. Sidan visar hur skyddad varje plats är under **hela** vistelsen och
rangordnar platserna efter den sämsta timmen. Med *Nära mig* visas bara platser inom valt avstånd från dig.

> **Endast ett hjälpmedel.** Ersätter inte sjökort, egen bedömning och gott sjömanskap.

## Så fungerar det

1. `scripts/build_profiles.py` hämtar platserna (`scripts/places.tsv`) och kustlinjen från OpenStreetMap.
   För varje plats räknar skriptet ut stryklängden var tionde grad och sparar resultatet i `data/profiles.json`.
2. `index.html` och `app.js` hämtar vindprognosen från SMHI direkt i webbläsaren och kombinerar den med
   skyddsprofilen timme för timme. Sidan behöver ingen server.

Mer detaljer finns i [method.html](method.html).

## Köra lokalt

```bash
python3 scripts/build_profiles.py     # behövs bara när places.tsv ändras
python3 -m unittest discover -s tests # test av stryklängdsberäkningen
python3 scripts/validate_waves.py      # kontroll mot SMHI:s vågboj i Hårsfjärden
python3 scripts/calibrate.py           # kalibrering med korsvalidering → data/calibration.json
python3 -m http.server 8000           # öppna http://localhost:8000
```

Skripten använder bara Pythons standardbibliotek.

## Publicera på GitHub Pages

Repot: Settings → Pages → Build and deployment → Source: *Deploy from a branch*,
Branch: `main`, mapp `/ (root)` → Save. Efter någon minut finns sidan på
https://oliverdahlgren.github.io/ankarlugn/.

SMHI:s API tillåter anrop direkt från webbläsaren, så sidan behöver ingen server eller GitHub Action.

## Loggning för framtida kalibrering

GitHub Action `.github/workflows/logg.yml` körs fyra gånger per dygn. Den sparar SMHI:s prognosvind 48 h framåt
och uppmätt vind och vågor för fem vindstationer och vågbojen Huvudskär Ost, som CSV-filer på grenen
[`logg`](../../tree/logg). Med några månaders data kan vågmodellen kalibreras mot just prognosvinden,
vilket den första kalibreringen inte kunde (se metodsidan).

Scheman i GitHub Actions stängs av om repot är helt inaktivt i 60 dagar. GitHub skickar då ett mejl, och loggningen
kan slås på igen under fliken Actions.

## Källor och licenser

- Platser och kustlinje: © OpenStreetMap-bidragsgivare, [ODbL](https://www.openstreetmap.org/copyright).
  `data/profiles.json` är härledd från OSM-data och omfattas av ODbL.
- Vindprognos: [SMHI öppna data](https://www.smhi.se/data/oppna-data), CC BY 4.0.
- Sjömärken i kartan: OpenSeaMap.
