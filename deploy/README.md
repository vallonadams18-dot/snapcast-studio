# Deploying Snapcast Studio

Target: a fresh **Ubuntu 24.04** server (DigitalOcean droplet, 2GB RAM minimum
— ffmpeg needs the headroom).

## 1. Connect to the server

From Windows PowerShell (or any terminal):

```
ssh root@YOUR_SERVER_IP
```

First connection asks to confirm the host fingerprint — type `yes`.

## 2. Base setup (one time)

```
apt-get update && apt-get install -y git
git clone YOUR_GITHUB_REPO_URL /srv/snapcast
cd /srv/snapcast
bash deploy/server-setup.sh
```

Installs Node 22, ffmpeg, fonts, nginx, certbot, a firewall, and the
`snapcast` service user.

## 3. Configure secrets

```
cp .env.example .env
nano .env
```

Fill in at minimum:

- `DATABASE_URL="file:/var/lib/snapcast/snapcast.db"` — outside the app dir so
  deploys can't clobber it
- `ANTHROPIC_API_KEY` — without it captions are generic placeholders
- `EPIDEMIC_SOUND_API_KEY` — without it clips get a track *tag* but no audio

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

Lock it down — it holds live API keys:

```
chown snapcast:snapcast .env && chmod 600 .env
```

## 4. First deploy

```
chown -R snapcast:snapcast /srv/snapcast /var/lib/snapcast
bash deploy/deploy.sh
```

Run this **as root** — it drops to the `snapcast` user for the build steps
itself, then uses root for `systemctl restart`. Don't run it via
`sudo -u snapcast`: that account is a `--system` user with no password, so any
`sudo` inside it hangs on a prompt it can never answer.

## 5. Run as a service

```
cp deploy/snapcast.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now snapcast
systemctl status snapcast
```

## 6. Put nginx in front

```
cp deploy/nginx-snapcast.conf /etc/nginx/sites-available/snapcast
ln -sf /etc/nginx/sites-available/snapcast /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

The app should now answer at `http://YOUR_SERVER_IP`.

## 7. HTTPS (needs a domain)

Point an A record at the server IP, wait for DNS to propagate, then:

```
certbot --nginx -d your-domain.com
```

Certbot edits the nginx config and sets up auto-renewal.

**Worth doing before real use.** Over plain HTTP, browsers mark the site "not
secure", and some mobile browsers restrict camera/file access on insecure
origins — which matters when staff upload from phones at a venue.

## Updating later

```
ssh root@YOUR_SERVER_IP
cd /srv/snapcast && sudo -u snapcast bash deploy/deploy.sh
```

## Backups

Everything that matters is two paths:

- `/var/lib/snapcast/snapcast.db` — accounts, events, drafts, captions
- `/srv/snapcast/public/uploads` — the actual photos and video

A nightly copy of both to another machine or object storage is enough. The
database is a single SQLite file, so `cp` while the app runs is safe with WAL
mode — but `sqlite3 snapcast.db ".backup out.db"` is the correct way to get a
guaranteed-consistent snapshot.

## Troubleshooting

```
journalctl -u snapcast -f          # live app logs
systemctl status snapcast          # is it running?
nginx -t                           # nginx config valid?
ffmpeg -version                    # ffmpeg present?
free -h                            # out of memory? (ffmpeg is hungry)
```

**Video jobs failing but photos fine** — almost always memory. Check `free -h`
during an encode; resize the droplet if it's exhausted.

**Uploaded photos/videos 404 or show as broken images** — the nginx
`location /uploads/` block is missing or points at the wrong path. Next does
**not** serve runtime-written files out of `public/` in production, so nginx
has to. Check with:

```
curl -I http://localhost/uploads/SOME_EVENT_ID/SOME_FILE.jpg
ls /srv/snapcast/public/uploads          # is the file actually on disk?
```

A 404 from nginx with the file present on disk means the `alias` path is
wrong. A 404 with nothing on disk means the upload itself failed — check
`journalctl -u snapcast`.

**Captions are generic placeholder text** — `ANTHROPIC_API_KEY` isn't set or
isn't reaching the process. Confirm with
`systemctl show snapcast -p Environment`, and remember the service reads
`/srv/snapcast/.env` via `EnvironmentFile`.
