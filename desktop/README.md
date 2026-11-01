# Clipsmith Desktop

Spela in skärmen och få tillbaka en tajtad huvudvideo plus vertikala shorts. **Allt körs i en och samma app:**
Clipsmith installerar, startar och stänger sin egen redigeringsmotor (backend). Du startar inget separat.
Appen är byggd i Electron (TypeScript, inget ramverk i gränssnittet).

## Kom igång

Det finns tre vägar. Börja med den första om du bara vill dubbelklicka.

### Väg 1: en vanlig installationsfil (inget att installera i förväg)

Projektet innehåller ett byggrecept (`../.github/workflows/build.yml`) som låter GitHub bygga installationsfilerna åt
dig, så du slipper Node och alla utvecklingsverktyg på din egen dator:

1. Skapa ett gratis konto på github.com och ett nytt **privat** repo, t.ex. `clipsmith`.
2. Klicka "uploading an existing file" och dra in innehållet i den uppackade mappen `clipsmith` (inte själva mappen).
   Webbläsaren tar högst 100 filer åt gången, så gör det i två omgångar: först `backend`, `contract`, `scripts`,
   `README.md`, `.gitignore`; sedan `desktop` och `.github`. Klicka "Commit changes" efter varje. (`.github` är en dold
   mapp: på Mac visas den med Cmd+Skift+punkt, och den måste vara med, annars finns inget byggrecept.)
3. Öppna fliken **Actions**, välj **Bygg Clipsmith** och klicka **Run workflow**. Det tar ungefär 10 minuter.
4. Öppna det färdiga bygget och ladda ner din fil längst ned under **Artifacts**: `clipsmith-windows` (en `.exe`),
   `clipsmith-mac` (en `.dmg`) eller `clipsmith-linux` (en `.AppImage`).
5. Installera som vanligt. På Windows är det en en-klicks-installation utan administratörsrättigheter och du får en
   genväg i startmenyn.

Filerna är **osignerade**, så systemet varnar första gången: Windows visar "Windows skyddade din dator", välj
**Mer info → Kör ändå**. På Mac: högerklicka appen och välj **Öppna** (säger Mac att filen är skadad, kör
`xattr -cr /Applications/Clipsmith.app` i Terminal). Vill du ha en nedladdningssida i stället för "Artifacts", skapa en
release med en tagg som börjar på `v` (t.ex. `v0.1.0`); då lägger bygget filerna där automatiskt.

### Väg 2: dubbelklicka i mappen (kräver Node, som skriptet försöker installera åt dig)

I mappen `desktop` finns `Starta Clipsmith.bat` (Windows), `Starta Clipsmith.command` (Mac) och `starta-clipsmith.sh` (Linux).
Dubbelklicka. Första gången hämtar skriptet Node.js om det saknas (Windows: via `winget`, Mac: via Homebrew om det finns),
kör `npm install` och startar appen. Därefter startar den direkt.

### Väg 3: terminal

Kräver Node 22.18 eller senare.

```bash
cd desktop
npm install
npm start
```

### Python behöver du inte installera

Hittar appen ingen fungerande Python 3.11+ hämtar den en egen kopia (en vanlig CPython från projektet
[python-build-standalone](https://github.com/astral-sh/python-build-standalone), ca 50 MB) till sin egen mapp. Filen
används först när dess SHA-256 stämmer med kontrollsumman som släppet publicerar. Din egen Python rörs aldrig. Finns
en fungerande Python på datorn används den i första hand; kan den inte skapa en egen miljö (vanligt på Ubuntu utan
`python3-venv`) byter appen automatiskt till den egna kopian. Går nedladdningen inte att göra visas orsaken och en knapp
till python.org.

### Första starten

Första gången gör appen följande på egen hand, och visar varje steg under fliken **Motor**:

| Steg | Vad som händer | Tar |
|---|---|---|
| 1. Letar efter Python | Hittar Python 3.11+ (provar `py`, `python3`, `python`, Homebrew) | sekunder |
| 2. Installerar Python och paketen | Hämtar en egen Python om ingen finns, skapar en privat miljö i appens mapp och installerar FastAPI, faster-whisper m.m. | några minuter, kräver internet |
| 3. Hämtar taligenkänning | Laddar ner Whisper-modellen du valt (standard "Liten", ca 0,5 GB) | beroende på uppkoppling |
| 4. Startar motorn | Startar den på en ledig port på `127.0.0.1` och väntar tills den svarar | sekunder |

Nästa gång finns allt på plats och motorn är klar på några sekunder. Du kan spela in medan motorn görs i ordning;
det är bara **Skicka till redigering** som väntar på den. Slutar motorn fungera (krasch) startar appen om den
automatiskt, och när du stänger appen stängs motorn med den. Dör appen oväntat avslutar motorn sig själv.

Första gången frågar appen efter din profil (nisch, klipptempo, undertextstil, språk). Under **Motor** väljer du
taligenkänningsmodell och lägger in din **API-nyckel** från Anthropic (<https://console.anthropic.com>).

### Vad nyckeln gör (och inte gör)

- **Med nyckel:** AI:n bestämmer vad som är onödigt, kortar huvudvideon mot ditt mål (t.ex. 10 minuter) och väljer de
  bästa klippen till shorts.
- **Utan nyckel:** en enklare regelbaserad redigering. Tystnad och utfyllnadsord tas bort och tydliga omtagningar
  klipps, och shorts väljs efter hur tätt det pratas. **Videon blir inte kortare än så**, den kortas alltså inte mot
  ditt mål. Hemskärmen säger det rakt ut tills en nyckel finns.
- Nyckeln sparas krypterad med datorns nyckelring (Keychain, Credential Manager, libsecret). Saknas nyckelring
  (vissa Linux-skrivbord) ligger den i en fil som bara ditt konto kan läsa, och Motor-fliken säger det. Nyckeln
  ligger aldrig i `settings.json`, skickas aldrig till gränssnittet och skrivs aldrig i loggen.

### Om något går fel

Fliken **Motor** visar vilket steg som fastnade, en förklaring på svenska och knappar:

| Du ser | Det betyder | Gör så här |
|---|---|---|
| "Kunde inte hämta Python" | Ingen Python på datorn och ingen kontakt med github.com | Kontrollera internet/proxy, **Försök igen**, eller **Öppna python.org** och installera själv |
| "Kunde inte hämta Python-paketen" | Ingen kontakt med paketservern (pypi.org) | Kontrollera internet/proxy, **Försök igen** |
| "Kunde inte hämta taligenkänningsmodellen" | Modellen gick inte att ladda ner (hämtas från huggingface.co) | Kontrollera internet och diskutrymme, **Försök igen**, eller välj en mindre modell |
| "Motorn fortsätter stanna" | Den kraschade flera gånger i rad | Öppna loggen, välj **Reparera installationen** |
| "Din ffmpeg saknar stöd för undertexter" (eller H.264) | Den medföljande ffmpeg saknar `libass`/`libx264` | Appen provar systemets ffmpeg först automatiskt; annars installera en ffmpeg som har dem |
| "Python kan inte skapa en egen miljö", "Disken är full" m.fl. | Se förklaringen i rutan | Följ förklaringen, **Försök igen** |

**Reparera installationen** får appen att glömma att paketen är installerade, så `pip` körs om från början. Dina inspelningar rörs inte. Vill du börja helt om kan du ta bort mappen `engine/` (se nedan).

### Egen server i stället (avancerat)

Under **Motor → Avancerat** kan du välja "Använd min egen server" och ange adressen till en backend som du kör själv
(`uvicorn clipsmith.api.app:app --factory`, se `../backend/README.md`). Då startar appen ingen motor, och modell och
nyckel ställs in på den servern. Äldre inställningar där serveradressen ändrats flyttas automatiskt hit.

## Var ligger saker?

| Vad | Var |
|---|---|
| Inspelningar | `Videor/Clipsmith/` i din hemkatalog |
| Inställningar | `settings.json` i appens användardata (inga hemligheter) |
| API-nyckel | `api-key.json` i appens användardata (krypterad när det går) |
| Motorn (miljö, modell, jobb) | `engine/` i appens användardata. Ta bort mappen för att börja om |

Appen kopierar upp inspelningen till motorn, och motorn raderar sin uppladdade kopia när jobbet är klart. Din
originalinspelning ligger kvar under `Videor/Clipsmith/` tills du tar bort den. Att ta bort en inspelning i appen
raderar också resultaten i motorn.

## Kommandon

| Kommando | Gör |
|---|---|
| `npm start` | Bygger och startar Electron |
| `npm run build` | Kompilerar main, preload och renderer till `dist/` via `scripts/build.mjs --strict` (typfel stoppar). Kontrollerar sedan att alla filer och alla hänvisningar mellan dem finns |
| `npm test` | Enhetstester och integrationstester (Node, ingen Electron behövs) |
| `npm run typecheck` | Typkontroll av alla tre delprojekten |
| `npm run pack` / `npm run dist` | Bygger (typfel visas men stoppar inte), paketerar med electron-builder till `release/` och kontrollerar sedan innehållet i den färdiga `app.asar` med `scripts/verify-package.mjs` (**oprövat med riktiga electron-builder lokalt**, se nedan; byggs normalt av GitHub, väg 1) |
| `npm run gen:contract` | Genererar om `contract.generated.ts` från backendens modeller |

Sätt `CLIPSMITH_DEVTOOLS=1` för att öppna utvecklarverktygen i huvudfönstret.

## Hur det hänger ihop

```
 Huvudfönster (UI)           Inspelningsrad (litet fönster)
   renderer/app.ts             renderer/recorder.ts + capture.ts
        │  Bridge (contextBridge, preload.cts)  │
        └──────────────┬────────────────────────┘
                       ▼
              main/index.ts  (Electron-limmet: fönster, IPC, genvägar, nyckelring, behörigheter)
                       │  Host-gränssnitt                       │ Engine-gränssnitt
                       ▼                                        ▼
              main/controller.ts                       main/backend-manager.ts
              (tillståndsmaskinen,                     (Python → venv → pip → modell → start → övervaka → stopp)
               inget Electron-beroende)                          │ startar som barnprocess
                 │            │             │                    ▼
         sessions.ts   recording-sink.ts   shared/api.ts ──HTTP──▶ python -m clipsmith.serve (127.0.0.1)
```

Fasordningen är `idle → starting → recording ⇄ paused → finalizing → ready → uploading → processing → done` (eller `failed`).
Allt som rör nätverk, disk och processer sker i main-processen. Fönstren får bara tillståndsögonblicksbilder (`AppState`)
och anropar `Bridge`. `Controller` får allt från operativsystemet via `Host` och motorn via `Engine`, så hela flödet kan
köras i tester med en falsk host, riktiga filer, riktiga processer och en riktig HTTP-server.

### Motorns livscykel (`backend-manager.ts`)

- **Python** hittas av `python.ts` (≥ 3.11; föredrar 3.12, 3.13, 3.11; 3.14 används men markeras som nyare än vad som provats).
  Saknas den, är för gammal eller kan inte skapa en venv hämtar `python-fetch.ts` en egen (se ovan): releasen läses via
  GitHubs API (reservväg: en fast release), filen kontrolleras mot SHA-256, packas upp med systemets `tar` (Windows:
  `System32\tar.exe`), och provas (`venv`, `ensurepip`, `ssl`, `sqlite3`) innan den används. Hanterar timeout vid hängd
  anslutning och avbryts när du trycker "Försök igen" eller stänger appen.
- **Privat venv** i `engine/venv`. `pip install -r backend/requirements.txt` körs bara när kravlistan ändrats
  (SHA-256-stämpel i `setup.json`), så uppdateringar av appen med nya krav installerar om automatiskt.
- **Systemkontroll** (`python -m clipsmith.system`): ffmpeg och ffprobe finns, ffmpeg har `libass` och `libx264`, paketen går
  att importera. Den medföljande ffmpeg (npm `ffmpeg-static`) provas först, sedan systemets.
- **Modell** hämtas av `python -m clipsmith.prefetch` till `engine/hf` (stämpel per modell), så första jobbet inte stannar.
- **Start** på en ledig port, `/health` måste svara `{ok: true, version}` innan motorn räknas som redo.
- **Övervakning**: omstart efter 1, 3 och 8 sekunder, ger upp efter upprepade krascher. Saknade paket (exitkod 3) försöks inte om.
- **Stopp**: SIGTERM, sedan SIGKILL efter en frist, mot hela processgruppen (Windows: `taskkill /T /F`).
- **Föräldralös motor omöjlig**: appen håller en rör till motorns stdin öppet, och motorn avslutar sig själv när det stängs.
- Jobb som avbröts när motorn stannade markeras som avbrutna vid nästa start i stället för att hänga för evigt.

### Designval värda att känna till

- **Electron, inte Tauri.** `getDisplayMedia` är opålitligt i WKWebView och WebKitGTK (Tauri-issue #2600). Electron levererar
  en känd Chromium-version med inspelning som fungerar likadant på alla tre plattformarna.
- **Inspelningen skrivs till disk medan den pågår** (en bit per sekund). Kraschar appen finns det som hann sparas kvar och
  visas som "Återställd efter avbrott" nästa start.
- **Uppladdningen strömmas** med exakt `Content-Length` (ingen buffring av hela filen i minnet), försöker om vid
  nätverksfel men aldrig vid 4xx, och släpper filen oavsett utfall.
- **Kontraktet har en enda källa.** Listor och gränser (nischer, tempon, undertextstilar, 1–60 minuter, 1–8 shorts, …)
  genereras från backendens modeller av `scripts/gen_contract.py`. Ett Python-test misslyckas om de genererade filerna
  är inaktuella.
- **Klippkartan** (resultatvyn) ritas från `main.edl.json`: hela originalinspelningen som ett band, blått där innehåll
  behölls och streckat där det klipptes.
- **Inspelningsraden i bild.** Electron kan inte pålitligt utesluta ett fönster från en helskärmsinspelning
  (`setContentProtection` fungerar inte överallt, Electron #19880). Därför finns valet "Göm inspelningsraden": raden
  döljs när nedräkningen är klar och du styr med globala genvägar (`Ctrl/Cmd+Skift+R` stopp, `Ctrl/Cmd+Skift+P` paus).
  Raden döljs bara om genvägarna faktiskt kunde registreras. Vid fönsterinspelning syns raden aldrig.
- **Säkerhet.** Sandboxad preload som bara exponerar `Bridge`, `contextIsolation`, ingen `nodeIntegration`, UI:t serveras
  från ett eget `clipsmith://app/`-schema med strikt CSP (inga inline-skript eller inline-stilar, `default-src 'none'`),
  all IPC kontrollerar avsändarens fönster och sida, navigering och nya fönster nekas. Motorn lyssnar bara på
  `127.0.0.1` och API-nyckeln når den bara som miljövariabel (aldrig som argument, som syns för alla processer).

## Skärmbilder

Ligger i `docs/screens/`: `light-17-home-no-key.png` (hem utan nyckel), `light-12-engine-installing.png` (första
installationen), `light-14-engine-no-python.png` (Python saknas), `dark-10-engine-ready.png` (motorn redo),
resultat- och profilvyerna samt inspelningsraden.

## Tester

```bash
npm test          # 184 tester: delad logik, controller, motorhanteraren och Python-hämtningen mot riktiga processer, statiska CSP-vakter, byggskriptet och paketkontrollen
```

Backendens 81 tester körs med `cd ../backend && PYTHONPATH=src python3 -m unittest discover -s tests -t .`.

Webbläsartesterna kräver Playwright med en Chromium och en skärm (på Linux: `xvfb-run`). Sökvägarna överst i skripten
pekar på den installation som användes under utvecklingen; justera dem för din dator.

```bash
tsc -p tsconfig.renderer.json && node scripts/copy-static.mjs   # bygger bara renderern
xvfb-run -a -s "-screen 0 1400x1000x24" node test/browser/run-ui.mjs       dist/renderer <ut> <mediamapp>
xvfb-run -a -s "-screen 0 1280x720x24"  node test/browser/run-recorder.mjs dist/renderer <ut>
xvfb-run -a -s "-screen 0 1280x720x24"  node test/e2e/run-e2e.mjs         dist/renderer <arbetsmapp> 30
```

Testmedia till `run-ui.mjs` (VP9/WebM med `.mp4`-namn, eftersom Playwrights Chromium saknar H.264):

```bash
mkdir media && cd media
ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=25:duration=4 -f lavfi -i sine=duration=4 -c:v libvpx -c:a libopus -f webm main.mp4
for i in 1 2 3 4; do ffmpeg -y -f lavfi -i testsrc2=size=720x1280:rate=25:duration=3 -f lavfi -i sine=duration=3 -c:v libvpx -c:a libopus -f webm short_$i.mp4; done
```

- `run-ui.mjs` kör varje skärm mot en falsk brygga (ljust och mörkt läge, skärmbilder): flödena, alla motorlägen
  (installerar, hämtar modell, startar om, Python saknas, ingen uppkoppling, egen server), nyckelhantering,
  tangentbordsfokus, och övervakar CSP-brott och konsolfel.
- `run-recorder.mjs` kör inspelningsraden med den riktiga inspelningsmodulen och falska enheter.
- `run-e2e.mjs` spelar in på riktigt, låter appens egen `BackendManager` starta motorn (`test/e2e/backend_shim.py`, som
  har samma routes som `api/app.py` men standardbibliotekets HTTP-server; backendens egna `JobStore`, `JobRunner` och
  pipeline körs), laddar upp, hämtar resultaten, inspekterar filerna med ffprobe, stänger appen och startar den igen.
  Transkriptionen är fejkad eftersom testinspelningen saknar tal.

## Vad som är verifierat och vad som inte är det

Allt nedan gäller koden så som den levereras. "Verifierat" betyder att jag har kört det, inte att det ser rätt ut.

**Verifierat (riktig Chromium via Playwright/Xvfb, riktiga processer, riktig backendkod, riktig ffmpeg):**

- **Motorhanteraren mot riktiga barnprocesser**: start, `/health`, omstart efter krasch, att den ger upp efter upprepade
  krascher, stopp av hela processgruppen, att barnbarn dör, att motorn avslutar sig själv när appen dör (orphan-test
  med riktig process), att API-nyckeln bara når barnet via miljön och inte läcker till loggen, att en nyckel från
  skalet inte ärvs, bundlad ffmpeg först på PATH, riktig venv och riktig `pip` (mot en tom kravlista, eftersom nätverk saknas här; ett test kör riktig pip utan nätverk och kontrollerar att felet förklaras och loggen visas).
- **Hela kedjan** (`run-e2e.mjs`, 26 kontroller): appen startar sin motor och ser den bli redo, en 30 sekunder lång
  inspelning med paus, uppladdning med riktig HTTP, backendens riktiga pipeline, nedladdning (byte-identisk),
  ffprobe (längd stämmer med manifestet, shorts 1080×1920, ljud finns), den uppladdade kopian raderas, stängning av
  appen stänger motorn, och jobbet återöppnas efter omstart.
- **Gränssnittet** (`run-ui.mjs`, 36 kontroller + CSP-kontroll över 19 sidladdningar): alla skärmar i ljust och mörkt
  läge, profil, källval, ljudval, historik, uppladdning, bearbetning, resultat, fel, hela Motor-fliken (stegen,
  loggen som inte nollställs av framstegsuppdateringar, Python saknas, ingen uppkoppling, modellval, nyckel
  sparas/avvisas/tas bort med två klick, egen server), skicka-knappen som förklarar varför den är avstängd, och
  hemskärmens ärliga nyckelnotis. Inga CSP-brott, inga konsolfel.
- **Appens egen Python** (`python-fetch.test.ts`, 19 tester, och 8 i motorhanteraren): nedladdning mot en lokal server som härmar GitHubs releaser,
  kontrollsumma (en manipulerad fil avvisas), SHA256SUMS-tolkning, reservväg när API:t nekar, hängd anslutning, avbrott, arkiv med fel
  innehåll, trasig arkivfil, interpretator utan `ensurepip`, återanvändning och reparation av en skadad kopia, samt hur motorn
  beter sig när Python saknas, är gammal, inte kan skapa venv, eller nedladdningen misslyckas.
- **Startskriptet för Linux/Mac** (`starta-clipsmith.sh`) mot låtsas-`node`/`npm`: först-start, redan installerat, felande installation, felande start, Node saknas.
- **Byggskriptet och paketkontrollen** (`build-script.test.ts`, `verify-package.test.ts`, `after-pack.test.ts`, 31 tester): bygget
  stoppar när gränssnittet inte byggts, även när typfel annars tolereras; trasiga `import`-hänvisningar och html som pekar på
  saknade filer fångas; kontrollen av den färdiga `app.asar` slår larm för ett paket utan gränssnitt, utan motor eller utan
  ffmpeg; `after-pack` tar bort ffprobe för andra system. Kontrollen har dessutom körts mot den första riktiga installationsfilen
  från GitHub och hittade då det som var fel (se nedan). Testerna är mutationsprövade: stängs kontrollerna av går de röda.
- **Inspelningsraden** (10 kontroller) och **184 enhetstester/integrationstester** (`npm test`), **81 backendtester**.
- Typkontroll av main, preload, renderer och tester. Main och preload kontrolleras mot en handskriven stub av Electrons API.

**Inte verifierat, eftersom det kräver riktiga Electron, nätverk eller en annan dator:**

- **Själva Electron-limmet** (`main/index.ts`, `main/windows.ts`, `preload/preload.cts`). Electron-paketet gick inte att
  installera i min miljö, så appen har aldrig startats som Electron-app. Koden typkontrolleras mot en stub, vilket
  fångar fel i hur min kod hänger ihop men inte fel i hur jag tror att Electron fungerar. **Räkna med att första
  `npm start` kan kräva små justeringar.**
- **Den riktiga installationen**: `pip install` av FastAPI, uvicorn, faster-whisper och anthropic, nedladdningen av
  Whisper-modellen och att faster-whisper laddar den. Min miljö når inte PyPI eller Hugging Face. Hela
  installationskedjan är testad med riktig venv och riktig pip mot en lokal kravlista, men inte mot de riktiga paketen.
  Backendens FastAPI-lager (`api/app.py`) har inte körts här; testerna kör `backend_shim.py` med samma jobblogik.
- **Python 3.14** (paketens hjul kan saknas) och **Windows och macOS**: `taskkill`-vägen, `py`-startprogrammet och
  Homebrew-sökvägarna är skrivna efter dokumentationen men inte körda.
- **Medföljande ffmpeg** (`ffmpeg-static`, `ffprobe-static`) har inte installerats här. Appen kontrollerar vid start att
  ffmpeg har `libass` och `libx264` och faller tillbaka på systemets ffmpeg. Notera att ffmpeg-static är GPL-licensierad
  (bra att veta om du tänker distribuera appen).
- **Nyckelringen** (`safeStorage`) på riktiga operativsystem.
- **Paketering och byggrecept**: `build`-blocket i `package.json` (electron-builder, backend som `extraResources`, ffmpeg
  uppackad ur asar, en-klicks-installation på Windows, mikrofontext för macOS) och GitHub-receptet `.github/workflows/build.yml`
  är skrivna efter dokumentationen. Windows-bygget har körts en gång på GitHub och gav en installationsfil, men den
  saknade gränssnittet (`dist/renderer`). Första riktiga starten visade bara texten "Not found" i fönstret, vilket är vad appen
  svarar när gränssnittsfilerna saknas; svaret anger nu vilken fil och mapp det gäller (`main/serve-path.ts`, reglerna testade
  med både Windows- och Linux-sökvägar). Orsaken till att filerna föll bort är inte fastställd (jag har
  inte sett byggloggen). Bygget är därefter ändrat så att det inte längre kan lämna ifrån sig en sådan fil (`scripts/build.mjs`,
  `scripts/verify-package.mjs`), men det ändrade bygget har inte körts på GitHub än. Mac och Linux har jag ingen information
  om. Skicka felloggen från bygget om något stoppar; meddelandet "Bygget är inte komplett" listar då exakt vad som saknas.
  `scripts/after-pack.cjs` (tar bort ffprobe för andra system än det som byggs, ca 290 MB) är testad som filarbete men
  aldrig anropad av electron-builder. Ingen signering, notarisering, ikon eller autouppdatering, så systemen varnar vid första
  start. Mac-bygget är bara för Apple-processorer (arm64).
- **Python-nedladdningen mot riktiga GitHub**: filnamnen (`cpython-3.12.N+DATUM-<system>-install_only.tar.gz`), att
  släppet har en `SHA256SUMS`, att arkivet har mappen `python/` med `python.exe` respektive `bin/python3`, och att den riktiga
  Pythonen klarar `venv` på Windows, är skrivet efter projektets dokumentation men inte kört (min miljö nekas åtkomst till GitHub).
  Reservvägen pekar på en fast release (`20241016`, Python 3.12.7) som jag minns men inte har kunnat kontrollera.
- **Startskripten på Windows och Mac** (`Starta Clipsmith.bat`, `.command`): Linux-varianten är testad, de andra två är det inte.
  Windows-filen använder `winget`, som finns på Windows 10 (nyare versioner) och 11.
- **Undertextfonten Poppins** följer inte med; saknas den väljer ffmpeg en annan. Lägg `.ttf`-filer i
  `desktop/assets/fonts` (eller `resources/fonts` i en paketerad app) så hittar motorn dem.
- **`setDisplayMediaRequestHandler` utan användargest.** Playwrights Chromium släpper igenom `getDisplayMedia` utan klick;
  om Electron kräver gest för nedräkningsflödet måste capture startas på ett annat sätt.
- **Dolda inspelningsraden** (`hide()` med `backgroundThrottling: false`) och om den hamnar i helskärmsinspelningar.
- **Systemljud** (`audio: "loopback"`): Windows och macOS 13+ ska fungera, Linux kräver PulseAudio. Ej provat.
- **macOS-behörigheter** och återställning efter en riktig krasch.
- **H.264/MP4 i Electrons MediaRecorder.** Testerna kör WebM (VP9/Opus), som backend accepterar.
- **Prestanda**: ingen mätning av hur lång tid en 30-minutersinspelning tar med Whisper "small" på en vanlig dator.
  Räkna med att transkriptionen på CPU tar en betydande del av inspelningens längd.

**Kända begränsningar i designen:**

- Utan API-nyckel kortas videon inte mot målet (se ovan).
- Backend har ingen autentisering; den inbyggda motorn lyssnar därför bara på `127.0.0.1`.
- Uppladdningen kan inte återupptas: ett avbrott på en lång fil börjar om (tre försök vid nätverksfel).
- Sökning i långa webm-filer utan sökindex är inte mätt på mycket långa inspelningar (testat på 30–50 sekunder).
- Cursor- och klickloggning, smart zoom och ansiktsspårning är medvetet uppskjutna.
