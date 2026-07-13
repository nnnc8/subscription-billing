#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE="subscription-billing-smoke:${USER:-local}-$(date +%s)"
CONTAINER="subscription-billing-smoke-$$"
VOLUME="subscription-billing-smoke-volume-$$"
SESSION_SECRET='docker-smoke-session-secret-0123456789-0123456789'
ALLOWED_EMAIL='docker-smoke@example.com'
BASE_URL=''

cleanup() {
    docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
    docker volume rm --force "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
    echo 'Docker binary is unavailable' >&2
    exit 2
fi
if ! docker info >/dev/null 2>&1; then
    echo 'Docker daemon is unavailable' >&2
    exit 2
fi

docker build --tag "$IMAGE" --file "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
docker volume create "$VOLUME" >/dev/null

start_container() {
    docker run --detach \
        --name "$CONTAINER" \
        --publish '127.0.0.1::3000' \
        --mount "type=volume,src=$VOLUME,dst=/data" \
        --env NODE_ENV=production \
        --env HOST=0.0.0.0 \
        --env PORT=3000 \
        --env DATA_DIR=/data \
        --env MIGRATE_FROM_JSON=1 \
        --env PUBLIC_ORIGIN=http://127.0.0.1:3000 \
        --env APP_SESSION_SECRET="$SESSION_SECRET" \
        --env GOOGLE_CLIENT_ID=docker-smoke-client \
        --env GOOGLE_CLIENT_SECRET=docker-smoke-secret \
        --env GOOGLE_ALLOWED_EMAILS="$ALLOWED_EMAIL" \
        --env COOKIE_SECURE=false \
        "$IMAGE" >/dev/null

    for _ in $(seq 1 60); do
        if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
            sleep 1
            continue
        fi
        if [ "$(docker inspect --format '{{.State.Status}}' "$CONTAINER")" = 'exited' ]; then
            docker logs "$CONTAINER" >&2
            return 1
        fi
        local port
        port=$(docker port "$CONTAINER" 3000/tcp 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')
        if [ -n "$port" ]; then
            BASE_URL="http://127.0.0.1:$port"
            if node - "$BASE_URL" 2>/dev/null <<'NODE'
const response = await fetch(`${process.argv[2]}/api/health`);
if (!response.ok) process.exit(1);
const payload = await response.json();
if (payload.ok !== true || payload.readiness !== 'ready') process.exit(1);
NODE
            then
                return 0
            fi
        fi
        sleep 1
    done
    docker logs "$CONTAINER" >&2
    echo 'Container did not become healthy' >&2
    return 1
}

make_session_cookie() {
    APP_SESSION_SECRET="$SESSION_SECRET" ALLOWED_EMAIL="$ALLOWED_EMAIL" node <<'NODE'
const crypto = require('node:crypto');
const now = Date.now();
const payload = Buffer.from(JSON.stringify({
    v: 1,
    iat: now,
    exp: now + 7 * 24 * 60 * 60 * 1000,
    user: { email: process.env.ALLOWED_EMAIL, name: 'Docker Smoke' }
})).toString('base64url');
const signature = crypto.createHmac('sha256', process.env.APP_SESSION_SECRET).update(payload).digest('base64url');
process.stdout.write(`${payload}.${signature}`);
NODE
}

start_container
CONTAINER_UID=$(docker exec "$CONTAINER" id -u)
if [ "$CONTAINER_UID" = '0' ]; then
    echo 'Container is running as root' >&2
    exit 1
fi

SESSION_COOKIE=$(make_session_cookie)
BACKUP_NAME=$(node - "$BASE_URL" "sb_session=$SESSION_COOKIE" <<'NODE'
const baseUrl = process.argv[2];
const cookie = process.argv[3];

async function request(path, options = {}) {
    const headers = { Cookie: cookie, ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
    return payload;
}

const memberPayload = await request('/api/member', {
    method: 'POST',
    body: JSON.stringify({ name: 'Docker Smoke Member' })
});
const member = memberPayload.data?.members?.find(item => item.name === 'Docker Smoke Member');
if (!member?.id) throw new Error('created member was not returned');

const paymentPayload = await request('/api/payment', {
    method: 'POST',
    body: JSON.stringify({ memberId: member.id, amount: 7, method: 'docker-smoke', note: 'docker-smoke' })
});
if (!paymentPayload.data?.payments?.some(item => item.note === 'docker-smoke')) {
    throw new Error('created payment was not returned');
}

const backupPayload = await request('/api/backups/create', { method: 'POST' });
if (!backupPayload.filename) throw new Error('backup filename was not returned');
process.stdout.write(backupPayload.filename);
NODE
)

if [ -z "$BACKUP_NAME" ]; then
    echo 'Backup name was empty' >&2
    exit 1
fi

docker exec "$CONTAINER" sh -c 'touch /data/docker-smoke-marker'
LIVE_APP_FILES=$(docker exec "$CONTAINER" sh -c "find /app -type f \( -name 'database.db' -o -name 'database.db-wal' -o -name 'database.db-shm' -o -path '*/backups/*' \) -print")
if [ -n "$LIVE_APP_FILES" ]; then
    echo "Live data escaped /data:" >&2
    echo "$LIVE_APP_FILES" >&2
    exit 1
fi

IMAGE_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
HEALTH=$(node - "$BASE_URL" <<'NODE'
const response = await fetch(`${process.argv[2]}/api/health`);
process.stdout.write(await response.text());
NODE
)
echo "image_id=$IMAGE_ID"
echo "container_uid=$CONTAINER_UID"
echo "health=$HEALTH"
echo "backup=$BACKUP_NAME"
echo "data_files=$(docker exec "$CONTAINER" sh -c 'find /data -maxdepth 3 -type f -print | sort' | tr '\n' ';')"

docker rm --force "$CONTAINER" >/dev/null
start_container
if ! docker exec "$CONTAINER" test -f /data/docker-smoke-marker; then
    echo 'Volume marker did not survive container recreation' >&2
    exit 1
fi
if ! docker exec "$CONTAINER" test -f "/data/backups/$BACKUP_NAME"; then
    echo 'Backup did not survive container recreation' >&2
    exit 1
fi

node - "$BASE_URL" "sb_session=$SESSION_COOKIE" <<'NODE'
const response = await fetch(`${process.argv[2]}/api/data`, { headers: { Cookie: process.argv[3] } });
if (!response.ok) throw new Error(`/api/data returned ${response.status}`);
const payload = await response.json();
if (!payload.members?.some(item => item.name === 'Docker Smoke Member')) throw new Error('member did not survive recreation');
if (!payload.payments?.some(item => item.note === 'docker-smoke')) throw new Error('payment did not survive recreation');
NODE

echo 'docker smoke passed: authenticated member/payment/backup persisted across recreation'
