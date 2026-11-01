# Clipsmith backend (Fas 1)

## Flödet

```
video + preferences (JSON)
   │  POST /jobs
   ▼
 ffprobe ─► ljud (16 kHz) ─► silencedetect ──────────────────────────┐ (verklig tystnad)
                │                                                     │
                ▼                                                     │
        faster-whisper (ord + tidsstämplar)                           │
                │                                                     │
                ▼                                                     │
   units.py: ord → numrerade meningar (#id) + "liknar #N"-tips        │
                │                                                     │
                ▼                                                     ▼
   planner.py: LLM får text med #id och svarar med ID-intervall   timeline.py: ID → exakta klipp
   (aldrig tidsstämplar!)  ──► cuts / shorts  ───────────────────►  (pauskortning, fyllnadsljud,
                                                                      snap till tystnad, merge)
                                                                              │
                                                                              ▼
                                                      render.py: ETT FFmpeg-pass (trim+concat),
                                                      main.mp4  /  short_N.mp4 (9:16 + ASS-text)
```

**Kärnidén:** LLM:en fattar redaktionella beslut (*vad* ska bort) via ID:n.
`timeline.py` avgör *var* snittet hamnar – deterministiskt, testbart, ljudsäkert.
LLM:er är dåliga på att kopiera exakta tidsstämplar men bra på att peka ut numrerade rader.

## Kom igång

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"          # beroenden kommer från requirements.txt; kräver ffmpeg + ffprobe i PATH
export ANTHROPIC_API_KEY=sk-ant-...   # valfritt; utan nyckel används den enkla HeuristicPlanner
# Alla inställningar är miljövariabler (namnen står i .env.example). Filen .env läses INTE automatiskt:
# fyll i den och kör  set -a; source .env; set +a  eller exportera variablerna ett och ett.

# Utvecklingsloop utan server – iterera på prompts/klippparametrar:
clipsmith raw.mp4 --out out --niche garage --pace fast --shorts 4
clipsmith raw.mp4 --out out --no-llm        # deterministisk fallback, ingen API-nyckel

# Server:
uvicorn clipsmith.api.app:app --factory --reload

curl -F video=@raw.mp4 \
     -F 'preferences={"niche":"garage","pace":"fast","caption_style":"pop","source_type":"camera","niche_notes":"bil-el, scheman"}' \
     localhost:8000/jobs
curl localhost:8000/jobs/<id>                      # status, stage, progress, result
curl -O localhost:8000/jobs/<id>/files/main.mp4
```

Tester (stdlib, inga extra paket; kör riktig FFmpeg på syntetisk media):
`PYTHONPATH=src python -m unittest discover -s tests -t .` (81 tester)

## Som motor åt desktop-appen

Desktop-appen (`../desktop`) installerar och startar backend själv; du behöver inte följa "Kom igång" ovan för att använda den.
Tre små kommandon är gjorda för det och går även att köra för hand:

| Kommando | Gör |
|---|---|
| `python -m clipsmith.system` | Skriver en JSON-rapport (Python-version, ffmpeg/ffprobe, `libass`, `libx264`, importerbara paket). Exitkod 0 när allt **nödvändigt** är OK. Kontroll-id:n är stabila; appen översätter dem till svenska. |
| `python -m clipsmith.prefetch --model small` | Hämtar Whisper-modellen till Hugging Face-cachen (`HF_HOME`) och skriver förloppet som en rad per uppdatering. |
| `python -m clipsmith.serve --port 8765 --data-dir <mapp> [--exit-when-stdin-closes]` | Startar API:t. Vägrar annan adress än loopback utan `--allow-remote` (det finns ingen autentisering). Med `--exit-when-stdin-closes` avslutas processen när stdin stängs, så en motor som startats av en app som kraschar inte blir kvar som föräldralös. Avslutas med kod 3 om ett nödvändigt paket saknas. |

- **Beroenden** står på ett enda ställe, `requirements.txt` (rena `namn>=version`-rader). `pyproject.toml` läser den, och
  desktop-appen installerar från den i sin egen venv.
- **API-nyckeln** ges bara som miljövariabeln `ANTHROPIC_API_KEY`, aldrig som argument (de syns för alla processer).
- **`CLIPSMITH_DELETE_SOURCE_AFTER=1`** raderar den uppladdade källfilen när jobbet är klart (appen har sin egen kopia).
- **Avbrutna jobb:** vid start markeras jobb som stod som `queued`/`running` men vars process försvunnit som misslyckade
  med ett begripligt meddelande, i stället för att hänga för alltid (`JobStore.recover_interrupted`).
- `/health` svarar `{"ok": true, "version": "..."}`; appen räknar motorn som redo först när det stämmer.

## Filkarta

| Fil | Ansvar |
|---|---|
| `models.py` | `Preferences` – onboarding-kontraktet (nisch, tempo, textstil, källtyp, målminuter) |
| `pipeline/units.py` | ord → enheter; retake-detektion (`liknar #N`) |
| `pipeline/planner.py` | `LLMPlanner` / `HeuristicPlanner`, validering av otrodd LLM-output, shorts-urval |
| `pipeline/prompts.py` | system/user-prompts, nisch- och tempoprofiler, JSON-scheman |
| **`pipeline/timeline.py`** | **kärnan:** ID → klippintervall, pauskortning, snap-to-silence, käll→utdata-tidskarta |
| `pipeline/captions.py` | ASS (pop/karaoke/minimal) + SRT, efter omräkning till utdatatid |
| `pipeline/reframe.py` | 9:16: beskärning (kamera) / suddig bakgrund (skärm) / ansiktsspårning-sömmen |
| `pipeline/render.py` | filtergraf → ett decode + ett encode; loudnorm; 15 ms ljudfade per skarv |
| `pipeline/run.py` | orkestrering, "stram åt"-loop mot målfängd, manifest |
| `api/` | FastAPI + jobbstore (status.json) + trådpool |

## Designval värda att känna till

- **Icke-destruktivt:** varje jobb sparar `main.edl.json` (källa→utdata-intervall) och `transcript.json`.
  Det är grunden för en framtida "justera klippen"-vy i appen utan att köra om AI:n.
- **Stram-åt-loop:** blir huvudvideon > 112 % av målet efter första passet ber vi LLM:en om mer (max 2 extra pass),
  med den *uppmätta* längden i prompten.
- **LLM-output är otrodd input:** okända ID:n kastas, intervall begränsas, och trigger-happy klippning
  (> 75 % av talet) återställs, minst säkra klipp först.
- **Shorts väljs på originaltidslinjen** och stramas sedan åt ett snäpp hårdare än huvudvideon.
- **Tempo styr siffror, inte bara prompt:** `calm/balanced/fast` ändrar både LLM-instruktionen *och*
  pausgränser/fyllnadsljud i `PACE`.

## Kända begränsningar (ärligt)

- **Ansiktsspårning är bara en söm** (`reframe.estimate_x_center` → centrerad beskärning idag).
- Skärminspelning i 9:16 visar hela skärmen på 1080 px bredd: text blir liten. Desktop-appen bör logga
  cursor/klick så vi kan zooma till aktivt område (Fas 3).
- Uppladdning går rakt genom API:t. För stora mobilfiler: resumable upload (tus) eller presignade S3-URL:er.
- Jobbkö = trådpool + filer. Räcker för en maskin; byt till Redis/Arq + Postgres + objektlagring vid skalning.
- Whisper-kvalitet på svenska varierar: benchmarka `large-v3` mot KB-Whisper på *era* inspelningar.
- Inget är hårdvaruaccelererat än (NVENC/VideoToolbox) – `render.py` är enda stället att ändra.
