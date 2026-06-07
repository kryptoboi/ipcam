# 🎙️ AudioCam

**Kamera bezpieczeństwa z detekcją dźwięku na telefonie Android, wdrożona na Google Cloud Run.**

Jeden telefon działa jako kamera IP (podłączona do prądu i internetu), drugi jako odbiornik — synchronizacja przez **FolderSync**.

---

## ✅ Funkcje

| Funkcja | Status |
|---|---|
| Detekcja dźwięku z regulowanym progiem (dB) | ✅ |
| Nagranie 10-sek po wykryciu dźwięku | ✅ |
| Ciągłe nagranie 5-min na serwer | ✅ |
| Powiadomienia push (tylko przy dźwięku) | ✅ |
| Niskie zużycie baterii (throttled VU meter) | ✅ |
| Działa w przeglądarce Chrome/Android | ✅ |
| WebSocket – alerty w czasie rzeczywistym | ✅ |
| Synchronizacja przez FolderSync | ✅ |
| Wake Lock (brak wygaszania ekranu) | ✅ |
| Deploy na Google Cloud Run (HTTPS) | ✅ |
| GitHub Actions CI/CD | ✅ |

---

## 🏗️ Architektura

```
┌─────────────────────────────────────────────────────────┐
│                   Google Cloud Run                       │
│                                                         │
│  ┌───────────┐  ┌─────────────┐  ┌──────────────────┐  │
│  │  /camera  │  │  /receiver  │  │   WebSocket +    │  │
│  │  (PWA)    │  │   (PWA)     │  │   REST API       │  │
│  └───────────┘  └─────────────┘  └──────────────────┘  │
│                      │                                  │
│              ┌───────────────┐                          │
│              │  /recordings  │                          │
│              │  /clips (10s) │ ← FolderSync pobiera    │
│              │  /full  (5min)│                          │
│              └───────────────┘                          │
└─────────────────────────────────────────────────────────┘
         ↑                           ↑
  Telefon-Kamera               Telefon-Odbiornik
  Chrome browser               Chrome browser
  [podłączony do prądu]        FolderSync
```

---

## 🚀 Szybkie wdrożenie (5 minut)

### Wymagania
- Konto Google Cloud z aktywnym projektem
- Zainstalowany [Google Cloud SDK](https://cloud.google.com/sdk/install)
- Node.js 18+

### 1. Sklonuj repozytorium

```bash
git clone https://github.com/TWOJ_USERNAME/audiocam.git
cd audiocam
```

### 2. Uruchom setup

```bash
chmod +x deploy/setup-gcloud.sh
bash deploy/setup-gcloud.sh
```

Skrypt automatycznie:
- Generuje klucze VAPID (Web Push)
- Zapisuje sekrety w Cloud Secret Manager
- Buduje obraz Docker
- Wdraża na Cloud Run
- Wyświetla URL serwera

### 3. Otwórz w telefonach

Po wdrożeniu:
- **Kamera** → `https://twoj-serwer.run.app/camera`
- **Odbiornik** → `https://twoj-serwer.run.app/receiver`

---

## 📱 Konfiguracja telefonów

### Telefon-Kamera
1. Otwórz `https://twoj-serwer.run.app/camera` w Chrome
2. Zezwól na dostęp do kamery i mikrofonu
3. Opcjonalnie: **Dodaj do ekranu głównego** (PWA)
4. Ustaw próg detekcji dźwięku suwakiem
5. Naciśnij **▶ Start monitoring**
6. Podłącz ładowarkę

> ⚠️ Telefon musi być podłączony do prądu. Ekran może być wygaszony — Wake Lock utrzyma połączenie.

### Telefon-Odbiornik
1. Otwórz `https://twoj-serwer.run.app/receiver` w Chrome
2. W zakładce **Ustaw.** podaj URL serwera i token
3. Naciśnij **🔔 Włącz powiadomienia push**
4. Opcjonalnie: **Dodaj do ekranu głównego**

---

## 📁 Konfiguracja FolderSync

FolderSync synchronizuje 10-sekundowe klipy z serwera na drugi telefon.

1. Zainstaluj [FolderSync](https://play.google.com/store/apps/details?id=dk.tacit.android.foldersync.full)
2. Dodaj konto → **SFTP** lub **WebDAV** (wskazując na twój serwer)
   - Alternatywnie: Google Drive / Dropbox jeśli skonfigurujesz zewnętrzny storage
3. Dodaj parę folderów:
   - **Folder zdalny:** `/recordings/clips/`
   - **Folder lokalny:** `/sdcard/AudioCam/clips/`
   - **Kierunek:** Zdalny → Lokalny (tylko pobieranie)
4. Harmonogram: **Co 1 minutę** lub **Przy nowym pliku**
5. Włącz **Powiadomienie przy nowym pliku**

> 💡 Klipy pojawią się w galerii telefonu automatycznie po synchronizacji.

---

## 🔧 Zmienne środowiskowe

| Zmienna | Opis | Domyślna |
|---|---|---|
| `AUTH_TOKEN` | Token do autoryzacji API | `changeme-strong-token` |
| `VAPID_PUBLIC_KEY` | Klucz publiczny Web Push | — |
| `VAPID_PRIVATE_KEY` | Klucz prywatny Web Push | — |
| `VAPID_EMAIL` | Email VAPID | `mailto:admin@example.com` |
| `MAX_RECORDINGS` | Max liczba 5-min nagrań | `100` |
| `RECORDINGS_DIR` | Katalog nagrań | `/app/recordings` |
| `PORT` | Port serwera | `8080` |

---

## 🔄 GitHub Actions CI/CD

Skonfiguruj automatyczne wdrożenie przy każdym push na `main`:

1. Idź do **Settings → Secrets and variables → Actions** w GitHub
2. Dodaj sekrety:
   - `GCP_PROJECT_ID` — ID projektu Google Cloud
   - `GCP_SA_KEY` — JSON klucza service account z rolami:
     - `Cloud Run Admin`
     - `Storage Admin`
     - `Secret Manager Secret Accessor`

```bash
# Wygeneruj klucz service account
gcloud iam service-accounts create audiocam-deployer \
  --display-name="AudioCam Deployer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:audiocam-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:audiocam-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

gcloud iam service-accounts keys create key.json \
  --iam-account="audiocam-deployer@$PROJECT_ID.iam.gserviceaccount.com"

# Skopiuj zawartość key.json do sekretu GCP_SA_KEY w GitHub
cat key.json
```

---

## 📡 REST API

| Endpoint | Metoda | Opis |
|---|---|---|
| `/api/status` | GET | Status serwera (bez auth) |
| `/api/clips` | GET | Lista 10-sek klipów |
| `/api/recordings` | GET | Lista 5-min nagrań |
| `/api/events` | GET | Log zdarzeń dźwiękowych |
| `/api/upload/clip` | POST | Upload klipu (multipart) |
| `/api/upload/recording` | POST | Upload nagrania (multipart) |
| `/api/subscribe` | POST | Subskrypcja Web Push |
| `/api/vapid-public-key` | GET | Klucz publiczny VAPID |

Autoryzacja: nagłówek `x-auth-token` lub parametr `?token=`.

---

## 💡 Wskazówki

- **Bateria kamery**: zawsze na ładowarce. Ustaw **nie ładuj powyżej 80%** jeśli telefon to wspiera.
- **Ekran**: może być wygaszony — Wake Lock utrzyma działanie w tle w Chrome Android.
- **Próg dźwięku**: zacznij od 30 dB, dostosuj do otoczenia. Wyżej = mniej czułe.
- **Cooldown**: czas wyciszenia między zdarzeniami. 10s zapobiega zalewowi klipów.
- **Cloud Run koszty**: darmowy tier obejmuje 2M zapytań/mies. Serwer kosztuje kilka zł/miesiąc.
- **Trwałość nagrań**: Cloud Run ma efemeryczny dysk (reset przy restart). Dla trwałości podłącz **Cloud Storage** lub **Google Drive**.

---

## 📂 Struktura projektu

```
audiocam/
├── server/
│   ├── server.js          # Node.js – WebSocket + API
│   └── package.json
├── camera-client/
│   ├── index.html         # Kamera – PWA
│   ├── sw.js              # Service Worker
│   └── manifest.json
├── receiver-client/
│   ├── index.html         # Odbiornik – PWA
│   └── sw.js
├── deploy/
│   ├── setup-gcloud.sh    # Skrypt konfiguracji GCloud
│   └── cloudrun.yaml      # Cloud Run deployment YAML
├── .github/
│   └── workflows/
│       └── deploy.yml     # GitHub Actions CI/CD
├── Dockerfile
├── cloudbuild.yaml        # Cloud Build
└── README.md
```

---

## 📄 Licencja

MIT — użyj, zmodyfikuj, wdróż do woli.
