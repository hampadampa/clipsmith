# Clipsmith (arbetsnamn)

Ekosystem som förvandlar ett långt råmaterial-streck till en färdig huvudvideo + 3–5 vertikala shorts.

```
clipsmith/
├── backend/     ← Fas 1, klar: upload → Whisper → LLM → FFmpeg            (81 tester)
├── desktop/     ← Fas 2a: Electron-app, allt-i-ett (startar sin egen motor)  (se desktop/README.md)
├── mobile/      ← Fas 2b, väntar: Expo/React Native
├── contract/    ← preferences.json, genereras från backendens modeller
└── scripts/     ← gen_contract.py (genererar contract/ och desktop/src/shared/contract.generated.ts)
```

**Köra appen.** Du behöver inte installera Python, och du behöver inte ens Node om du låter GitHub bygga en vanlig
installationsfil åt dig (väg 1 i `desktop/README.md`, med steg för steg). Alternativen:

- **Installationsfil:** `.github/workflows/build.yml` bygger `.exe` / `.dmg` / `.AppImage` på GitHub. Aldrig körd.
- **Dubbelklick från mappen:** `desktop/Starta Clipsmith.bat` (Windows), `Starta Clipsmith.command` (Mac), `starta-clipsmith.sh` (Linux).
- **Terminal:** `cd desktop && npm install && npm start` (Node 22.18+).

Första starten hämtar appen en egen Python om ingen finns, installerar motorns paket och hämtar taligenkänningsmodellen
(kräver internet, några minuter) och visar framstegen under fliken Motor. Lägg in en Anthropic-nyckel där för
AI-redigering. Läs `desktop/README.md` för vad som är verifierat och vad som inte är det (appen har aldrig startats som
riktig Electron-app i utvecklingsmiljön).

Kör backendens tester: `cd backend && PYTHONPATH=src python3 -m unittest discover -s tests -t .`
Kör desktop-testerna: `cd desktop && npm test` (139 tester; se `desktop/README.md` för webbläsar- och e2e-testerna).
