#!/bin/bash
# ============================================================
#  AudioCam – Skrypt konfiguracji Google Cloud
#  Uruchom: bash deploy/setup-gcloud.sh
# ============================================================

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     AudioCam – Setup Google Cloud        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Sprawdź wymagania ──────────────────────────────────────
check_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "❌ Brak: $1. Zainstaluj i spróbuj ponownie."; exit 1; }
}
check_cmd gcloud
check_cmd node
check_cmd npm

# ─── Zmienne ────────────────────────────────────────────────
echo "📝 Konfiguracja projektu:"
read -p "  Google Cloud Project ID: " PROJECT_ID
read -p "  Region [europe-west1]: " REGION
REGION="${REGION:-europe-west1}"
read -p "  Email VAPID (np. admin@twoja-domena.pl): " VAPID_EMAIL
read -p "  Token autoryzacji (zostaw puste = auto): " AUTH_TOKEN

if [ -z "$AUTH_TOKEN" ]; then
  AUTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo "  ✓ Wygenerowano token: $AUTH_TOKEN"
  echo "  ⚠️  ZAPISZ TEN TOKEN! Potrzebny do połączenia z kamerą."
fi

echo ""
echo "🔑 Generowanie kluczy VAPID..."
cd server
npm install --silent 2>/dev/null || true
VAPID_KEYS=$(node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(k.publicKey+'|||'+k.privateKey);")
VAPID_PUBLIC=$(echo $VAPID_KEYS | cut -d'|||' -f1)
VAPID_PRIVATE=$(echo $VAPID_KEYS | cut -d'|||' -f2)
cd ..
echo "  ✓ Klucze VAPID wygenerowane"

# ─── Konfiguracja gcloud ────────────────────────────────────
echo ""
echo "☁️  Konfiguracja Google Cloud..."
gcloud config set project $PROJECT_ID
gcloud config set run/region $REGION

# Włącz wymagane API
echo "  Włączam wymagane API..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

# ─── Secret Manager ─────────────────────────────────────────
echo ""
echo "🔒 Zapisuję sekrety w Secret Manager..."

create_or_update_secret() {
  local NAME=$1
  local VALUE=$2
  if gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "$VALUE" | gcloud secrets versions add "$NAME" --data-file=- --project="$PROJECT_ID"
    echo "  ✓ Zaktualizowano sekret: $NAME"
  else
    echo "$VALUE" | gcloud secrets create "$NAME" --data-file=- --project="$PROJECT_ID" --replication-policy=automatic
    echo "  ✓ Utworzono sekret: $NAME"
  fi
}

create_or_update_secret "audiocam-auth-token" "$AUTH_TOKEN"
create_or_update_secret "audiocam-vapid-public" "$VAPID_PUBLIC"
create_or_update_secret "audiocam-vapid-private" "$VAPID_PRIVATE"

# ─── Uprawnienia Cloud Run do Secret Manager ────────────────
echo ""
echo "🔐 Ustawiam uprawnienia..."
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in audiocam-auth-token audiocam-vapid-public audiocam-vapid-private; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" \
    >/dev/null 2>&1
done
echo "  ✓ Uprawnienia ustawione"

# ─── Zaktualizuj cloudbuild.yaml z regionem ─────────────────
sed -i "s|_REGION: europe-west1|_REGION: ${REGION}|g" cloudbuild.yaml 2>/dev/null || true

# ─── Build & Deploy ──────────────────────────────────────────
echo ""
echo "🏗️  Buduję i wdrażam na Cloud Run..."
gcloud builds submit \
  --config=cloudbuild.yaml \
  --project=$PROJECT_ID \
  .

# ─── Pobierz URL ─────────────────────────────────────────────
echo ""
SERVICE_URL=$(gcloud run services describe audiocam \
  --region=$REGION \
  --platform=managed \
  --format="value(status.url)" \
  --project=$PROJECT_ID)

# ─── Podsumowanie ────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         ✅  AudioCam wdrożony pomyślnie!                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  URL serwera:   ${SERVICE_URL}"
echo "║  Kamera:        ${SERVICE_URL}/camera"
echo "║  Odbiornik:     ${SERVICE_URL}/receiver"
echo "║  API Status:    ${SERVICE_URL}/api/status"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Token:         ${AUTH_TOKEN}"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  NASTĘPNE KROKI:                                         ║"
echo "║  1. Na telefonie-kamera otwórz: /camera                  ║"
echo "║  2. Na telefonie-odbiornik otwórz: /receiver              ║"
echo "║  3. Skonfiguruj FolderSync (patrz README.md)             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "⚠️  Zapisz token: $AUTH_TOKEN"
