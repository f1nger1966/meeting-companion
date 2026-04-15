#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-bot-cloudrun.sh
#
# Deploys the screenappai/meeting-bot container to GCP Cloud Run.
# Run this ONCE (or on update) from your Mac terminal with gcloud authed.
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project altonailabs
#
# After deploy, paste the printed Service URL into the Vibe Platform Registry
# as the BOT_SERVICE_URL secret for the meeting-companion app.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config — edit these before running ───────────────────────────────────────
PROJECT_ID="altonailabs"
REGION="us-central1"
SERVICE_NAME="meeting-bot-core"
IMAGE="screenappai/meeting-bot:latest"

# GCS bucket that meeting-bot will write recordings to.
# Must be the same bucket your firebaseClient.js uses (FIREBASE_STORAGE_BUCKET).
GCS_BUCKET="${FIREBASE_STORAGE_BUCKET:-your-firebase-storage-bucket}"

# Webhook URL — where meeting-bot POSTs completion events.
# Set to your Vibe8 app URL once deployed; use ngrok URL for local testing.
WEBHOOK_URL="${WEBHOOK_URL:-https://meeting-companion.labs.8x8.com/webhook/bot}"

# Shared auth token — must match BOT_BEARER_TOKEN in the Express app secrets.
BOT_BEARER_TOKEN="${BOT_BEARER_TOKEN:-change-me-before-deploy}"

# HMAC secret for webhook signature verification (optional but recommended).
BOT_WEBHOOK_SECRET="${BOT_WEBHOOK_SECRET:-change-me-before-deploy}"
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "▶  Deploying ${SERVICE_NAME} to Cloud Run"
echo "   Project : ${PROJECT_ID}"
echo "   Region  : ${REGION}"
echo "   Image   : ${IMAGE}"
echo ""

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  \
  --set-env-vars "\
REDIS_CONSUMER_ENABLED=false,\
STORAGE_PROVIDER=gcs,\
GCS_BUCKET=${GCS_BUCKET},\
WEBHOOK_URL=${WEBHOOK_URL},\
BOT_BEARER_TOKEN=${BOT_BEARER_TOKEN},\
BOT_WEBHOOK_SECRET=${BOT_WEBHOOK_SECRET}" \
  \
  --service-account "firebase-adminsdk@${PROJECT_ID}.iam.gserviceaccount.com" \
  \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --memory 2Gi \
  --cpu 2 \
  --concurrency 1 \
  --timeout 3600

echo ""
echo "✅  Deployment complete."
echo ""
echo "Next steps:"
echo "  1. Copy the Service URL printed above."
echo "  2. Add it as BOT_SERVICE_URL in the Vibe Platform Registry"
echo "     (registry.labs.8x8.com → meeting-companion → Secrets)."
echo "  3. The Express app will pick it up within 5–7 minutes — no redeploy needed."
echo ""
