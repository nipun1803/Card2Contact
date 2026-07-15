# Deployment — complete step-by-step guide

This is a single, linear, start-to-finish walkthrough of everything needed to
take Card2Contact from "code on your laptop" to "live in production on an
Oracle Cloud Ubuntu VPS, with CI/CD, HTTPS, health checks, and automatic
rollback." Follow it top to bottom in order. Every command is included and
explained — nothing is assumed.

**Two separate, independent Docker Compose setups are used** — one for local
development, one for production — rather than a single file that branches on
environment variables. They share the same architecture (postgres, backend,
frontend, nginx) but production only ever pulls pre-built, pre-tagged images
from Docker Hub (no `build:` step at all), so there's no ambiguity about what
actually runs on the server:

| | Local dev | Production |
|---|---|---|
| Compose file | `docker-compose.yml` | `docker-compose.prod.yml` |
| nginx config | `nginx.conf` | `nginx.prod.conf` |
| Frontend | built from source, Vite dev server + HMR on port 5173 | pre-built image, static bundle served by nginx on port 80 |
| Backend | built from source | pre-built image, pinned to a commit SHA tag |
| TLS | none (plain HTTP) | Let's Encrypt via Certbot, ports 80/443 |
| Postgres data | `./data/postgres` (bind mount) | `./data/postgres` (bind mount) |

---

## Step 0 — What you need before starting

- This repo, on your local machine.
- Docker Desktop (or Docker Engine + Compose plugin) installed locally, for steps 1–2.
- A [Docker Hub](https://hub.docker.com) account. This project pushes to the
  `nipun17572` namespace (`nipun17572/card2contact-backend`,
  `nipun17572/card2contact-frontend`).
- A GitHub account, to host the repo and run the CI/CD workflows.
- An Oracle Cloud (or any) Ubuntu 22.04+ VPS with a public IP, reachable over SSH.
- A domain name you control, for HTTPS (e.g. `card2contact.example.com`).
- Real credentials for: Mistral API key, Google OAuth client ID/secret (from
  Google Cloud Console).

---

## Step 1 — Run the app locally in dev mode

This confirms your machine can build and run everything before touching CI/CD
or a server.

```bash
cd card2contact
cp .env.example .env
```

Edit `.env` and fill in real values for `SESSION_SECRET` (any long random
string), `MISTRAL_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`. Leave the rest at their defaults.

```bash
docker compose up -d --build
```

What this does: reads `docker-compose.yml`, builds the `backend` image from
`backend/Dockerfile`, builds the `frontend` image from `frontend/Dockerfile`
using its `dev` target (Vite dev server with hot-module-reload), starts
`postgres` first and waits for its healthcheck, then starts `backend` and
`frontend`, then starts the `nginx` reverse proxy in front of everything.

Verify it's actually working:

```bash
curl -s http://localhost:8080/api/health
# {"status":"ok"}

open http://localhost:8080   # or just open it in a browser
```

Tear it down when you're done poking at it:

```bash
docker compose down
```

(Add `-v` only if you also want to wipe the local Postgres data at
`./data/postgres` — you usually don't need to.)

---

## Step 2 — Build and test the production images locally (optional but recommended)

This proves the exact images CI will build and push actually work, before any
of it touches a real server.

```bash
docker build ./backend -t nipun17572/card2contact-backend:localtest
docker build ./frontend --target prod -t nipun17572/card2contact-frontend:localtest
```

The frontend build here uses `--target prod`, which runs `npm run build`
(`tsc -b && vite build`) and then serves the compiled `dist/` folder via
nginx on port 80 inside the image — a completely different artifact from the
`dev` target used in Step 1.

Quick sanity check that they run:

```bash
docker run --rm -d --name c2c-test-backend -p 4001:4000 \
  -e PORT=4000 -e SESSION_SECRET=test -e MISTRAL_API_KEY=test \
  -e GOOGLE_OAUTH_CLIENT_ID=test -e GOOGLE_OAUTH_CLIENT_SECRET=test \
  -e GOOGLE_OAUTH_REDIRECT_URI=http://localhost/api/auth/google/callback \
  -e DATABASE_URL=postgres://c2c:c2c@localhost:5432/card2contact \
  nipun17572/card2contact-backend:localtest
curl -s http://localhost:4001/api/health
docker stop c2c-test-backend

docker run --rm -d --name c2c-test-frontend -p 8091:80 \
  nipun17572/card2contact-frontend:localtest
curl -s -o /dev/null -w "status=%{http_code}\n" http://localhost:8091/
docker stop c2c-test-frontend
```

Clean up the local test images once satisfied:

```bash
docker rmi nipun17572/card2contact-backend:localtest nipun17572/card2contact-frontend:localtest
```

---

## Step 3 — Push the code to GitHub

Done by you — no automation in this repo runs `git init` or `git push` on
your behalf.

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/card2contact.git
git push -u origin main
```

---

## Step 4 — Create Docker Hub access token

1. Log in to [hub.docker.com](https://hub.docker.com).
2. Account Settings → Security → **New Access Token**.
3. Name it something like `card2contact-ci`, scope: Read & Write.
4. Copy the token now — you can't view it again. You'll paste it into GitHub
   Secrets in Step 6.

---

## Step 5 — Provision and bootstrap the Oracle Cloud VPS

Create the VPS in the Oracle Cloud console (Ubuntu 22.04+, any shape with at
least 1 vCPU / 2GB RAM for this app), note its public IP, and make sure you
can SSH into it as `ubuntu` (or `root`, depending on the image) with your
Oracle-generated key first.

Then, as `root` (or via `sudo`), run the full bootstrap:

```bash
# Update the base system.
apt update && apt upgrade -y

# Install Docker Engine + the Compose plugin from Docker's official apt repo
# (the Ubuntu-bundled docker.io package is typically outdated).
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Create a non-root deploy user and add it to the docker group so it can run
# docker/docker compose without sudo (needed for the SSH-based deploy step).
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy

# Firewall: allow SSH, HTTP, HTTPS only.
apt install -y ufw
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Brute-force protection for SSH.
apt install -y fail2ban
systemctl enable --now fail2ban

# Prep the deploy directory. This is where docker-compose.prod.yml,
# nginx.prod.conf, and the production .env file will live.
mkdir -p /opt/card2contact
chown deploy:deploy /opt/card2contact
```

Generate a dedicated SSH keypair **on your local machine** — this is the key
GitHub Actions will use to connect, separate from your personal Oracle key:

```bash
ssh-keygen -t ed25519 -f ./deploy_key -N ""
```

This creates `deploy_key` (private — becomes a GitHub Secret in Step 6) and
`deploy_key.pub` (public — goes on the VPS). Authorize it on the VPS:

```bash
# Still as root on the VPS:
mkdir -p /home/deploy/.ssh
echo "<paste the contents of deploy_key.pub here>" >> /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

Test the connection from your local machine before moving on:

```bash
ssh -i ./deploy_key deploy@<VPS_PUBLIC_IP> "docker --version"
```

---

## Step 6 — Add GitHub repo secrets and branch protection

In your GitHub repo, go to **Settings → Secrets and variables → Actions →
New repository secret** and add each of these:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | `nipun17572` |
| `DOCKERHUB_TOKEN` | The access token from Step 4 |
| `VPS_HOST` | The VPS's public IP |
| `VPS_USER` | `deploy` |
| `VPS_PORT` | `22` |
| `VPS_SSH_KEY` | The full contents of the **private** key file `deploy_key` from Step 5 (including the `-----BEGIN OPENSSH PRIVATE KEY-----` / `-----END...` lines) |
| `MISTRAL_API_KEY_CI` | A separate, low-quota Mistral API key used only by the E2E job on pull requests — keep it distinct from the production key |

Note: `SESSION_SECRET`, `POSTGRES_*`, `MISTRAL_API_KEY` (production),
`GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are **not** added here — they go directly
into a `.env` file on the VPS in Step 8, and never pass through GitHub
Actions.

Then set up branch protection: **Settings → Branches → Add branch protection
rule** for `main` → require these status checks to pass before merging:
`backend-typecheck`, `backend-unit`, `backend-integration`, `backend-build`,
`backend-audit`, `frontend-typecheck`, `frontend-unit`, `frontend-build`,
`frontend-audit`, `secret-scan`, `docker-build-backend`,
`docker-build-frontend`, `e2e` (all defined in
`.github/workflows/pr-validation.yml`).

---

## Step 7 — Point your domain at the VPS

In your domain registrar / DNS provider, create an **A record**:

```
<YOUR_DOMAIN>   A   <VPS_PUBLIC_IP>
```

Wait for propagation before continuing:

```bash
dig <YOUR_DOMAIN> +short
# should print the VPS's public IP
```

---

## Step 8 — Copy production config to the VPS and create its .env

From your local machine, copy the two production files to the VPS:

```bash
scp -i ./deploy_key docker-compose.prod.yml nginx.prod.conf deploy@<VPS_PUBLIC_IP>:/opt/card2contact/
```

Edit `nginx.prod.conf` **before or after** copying it — either way, replace
every `<YOUR_DOMAIN>` placeholder with your real domain:

```bash
ssh -i ./deploy_key deploy@<VPS_PUBLIC_IP>
sed -i 's/<YOUR_DOMAIN>/your.actual.domain.com/g' /opt/card2contact/nginx.prod.conf
```

Still on the VPS, as the `deploy` user, prep directories and create the
production `.env`:

```bash
cd /opt/card2contact
mkdir -p backups data/postgres
nano .env
```

Paste and fill in real values:

```bash
POSTGRES_USER=c2c
POSTGRES_PASSWORD=<generate a strong random password>
POSTGRES_DB=card2contact
DATABASE_URL=postgres://c2c:<same password as above>@postgres:5432/card2contact

SESSION_SECRET=<long random string>
MISTRAL_API_KEY=<your production Mistral API key>

GOOGLE_OAUTH_CLIENT_ID=<your Google OAuth client id>
GOOGLE_OAUTH_CLIENT_SECRET=<your Google OAuth client secret>
GOOGLE_OAUTH_REDIRECT_URI=https://<YOUR_DOMAIN>/api/auth/google/callback

FRONTEND_URL=https://<YOUR_DOMAIN>
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X` in nano). Do **not** run
`docker compose up` yet — `nginx.prod.conf` references TLS certificates that
don't exist until the next step.

Also update the Google OAuth client in Google Cloud Console → APIs & Services
→ Credentials: add `https://<YOUR_DOMAIN>/api/auth/google/callback` as an
authorized redirect URI.

---

## Step 9 — Issue the TLS certificate

Still on the VPS, as root:

```bash
apt install -y certbot

certbot certonly --standalone \
  -d <YOUR_DOMAIN> \
  --agree-tos -m you@example.com --non-interactive
```

This temporarily binds port 80 itself (nothing else is listening on it yet)
and writes certificates to `/etc/letsencrypt/live/<YOUR_DOMAIN>/` on the VPS
host — which `docker-compose.prod.yml` mounts read-only into the `nginx`
container.

Set up automatic renewal with a hook that reloads nginx afterward:

```bash
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
docker compose -f /opt/card2contact/docker-compose.prod.yml exec -T nginx nginx -s reload
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer
```

Ubuntu ships `certbot.timer` already; this just makes sure it's enabled and
wires the reload hook.

---

## Step 10 — First manual deploy (proves the stack works before CI does it)

Still on the VPS, as the `deploy` user, in `/opt/card2contact`:

```bash
export TAG=latest
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The very first time you run this, `TAG=latest` will fail to pull unless an
image has already been pushed to Docker Hub — so before running this, either:
(a) push once manually from your local machine —

```bash
docker login -u nipun17572
docker build ./backend -t nipun17572/card2contact-backend:latest
docker build ./frontend --target prod -t nipun17572/card2contact-frontend:latest
docker push nipun17572/card2contact-backend:latest
docker push nipun17572/card2contact-frontend:latest
```

— or (b) just push to `main` on GitHub first (Step 11) and let CI build and
push the images, then come back and run the `docker compose ... up -d` above.

Verify:

```bash
curl -sf https://<YOUR_DOMAIN>/api/health
# {"status":"ok"}
```

Record this as the known-good deployed tag so the CI deploy workflow's
rollback logic has a starting point:

```bash
echo "latest" > /opt/card2contact/.deployed_tag
```

---

## Step 11 — Push to main and watch CI/CD deploy automatically

From your local machine:

```bash
git push origin main
```

This triggers `.github/workflows/deploy.yml`. Watch it run under the GitHub
repo's **Actions** tab. It runs three jobs in sequence:

1. **verify** — re-runs backend typecheck + unit tests and frontend
   typecheck + build, as a fast safety net.
2. **build-and-push** — logs into Docker Hub and builds + pushes both images,
   tagged `latest` and the commit SHA (e.g. `nipun17572/card2contact-backend:a1b2c3d`).
3. **deploy** — SSHes into the VPS and:
   - reads `.deployed_tag` to know the last known-good tag,
   - `docker compose -f docker-compose.prod.yml pull backend frontend` to
     fetch the new SHA-tagged images,
   - `docker compose -f docker-compose.prod.yml up -d` to restart with them,
   - polls `http://localhost/api/health` for up to 60 seconds,
   - on success, writes the new SHA into `.deployed_tag` and prunes old
     images (keeps the 5 most recent),
   - on failure, automatically redeploys the previous tag and fails the job
     so you're notified even though production is already restored.

Every subsequent `git push origin main` repeats this automatically — that's
the whole point of the pipeline.

---

## Everyday operations

### Pull requests

Every PR against `main` runs `.github/workflows/pr-validation.yml`:
typecheck, unit tests, integration tests (in-memory fake stores, no DB
container needed), `npm audit`, Gitleaks secret scanning, Docker image builds
+ Trivy vulnerability scans, and a full Playwright E2E run against the local
dev-mode stack (all specs are network-mocked for Google OAuth; the one spec
that calls the real Mistral OCR API, `api-contract.spec.ts`, is excluded from
CI to avoid live API cost).

### Manual rollback

If automatic rollback also failed, or you want to go back further than one
deploy:

```bash
ssh -i ./deploy_key deploy@<VPS_PUBLIC_IP>
cd /opt/card2contact
export TAG=<the commit sha you want to roll back to>
docker compose -f docker-compose.prod.yml pull backend frontend
docker compose -f docker-compose.prod.yml up -d
curl -sf http://localhost/api/health
echo "$TAG" > .deployed_tag   # once you've confirmed it's healthy
```

### Logs and debugging

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
cat /opt/card2contact/.deployed_tag
```

### Secret rotation

- **GitHub Secrets** — update via Settings → Secrets and variables → Actions.
  Takes effect on the next workflow run.
- **VPS `.env` values** — edit `/opt/card2contact/.env` directly, then:
  ```bash
  docker compose -f docker-compose.prod.yml up -d
  ```
  Rotating `SESSION_SECRET` signs out all existing users — expected, do it
  at low-traffic times.
- Rotating `POSTGRES_PASSWORD` requires updating both `POSTGRES_PASSWORD` and
  `DATABASE_URL` in `.env` together, then restarting.

### Database backup and restore

Set up a daily cron backup, as root on the VPS:

```bash
cat > /etc/cron.d/card2contact-backup <<'EOF'
0 3 * * * deploy cd /opt/card2contact && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > /opt/card2contact/backups/$(date +\%F).sql.gz && find /opt/card2contact/backups -name '*.sql.gz' -mtime +14 -delete
EOF
chmod 644 /etc/cron.d/card2contact-backup
```

Restore from a backup (stop the backend first so nothing writes mid-restore):

```bash
cd /opt/card2contact
docker compose -f docker-compose.prod.yml stop backend
gunzip -c backups/2026-07-14.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
docker compose -f docker-compose.prod.yml start backend
curl -sf http://localhost/api/health
```

Test the restore procedure at least once against a scratch database before
relying on it in a real incident.
