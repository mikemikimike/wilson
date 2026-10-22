# Local SonarQube pre-pass

Optional, fully local static analysis for `/security-gate` (replaces the DeepSec idea, which needs Vercel plus a cloud
model and would send source off the machine). Nothing here talks to SonarCloud or any hosted service.

| Script | What |
|---|---|
| `up.sh` | Start SonarQube Community on `127.0.0.1:9000` (named volumes), wait for `UP`, rotate the default admin password, create a scan token and project |
| `scan.sh <worktree> [project-key]` | Stage a clean copy of the tree, run the scanner container against it, write `issues.json`, `hotspots.json`, `summary.md` |
| `down.sh [--purge]` | Stop the server; `--purge` also deletes container, volumes, networks and token state |

Output and secrets live in `/private/tmp/claude-501/wilson-sonar/` (`admin-password`, `token` mode 600; `out/<key>/`).
Nothing is written into the repo. Override with `SONAR_STATE`, `SONAR_PORT`, `SONAR_NAME`.

## Pinned images (checked 2026-10-22)

- `sonarqube:26.10.0.133078-community@sha256:0b3408443fb6a311253de27941b10977c9b977fd53be2265947bfe14161308b8`
- `sonarsource/sonar-scanner-cli:12.2.0.4256_8.1.0@sha256:a3f4215076706c95a17a68c19322ee916e40a3acd081a8c1a1e839e0194afa57`
  (amd64 only; runs under Rosetta on Apple Silicon)

## Nothing leaves the machine (NN-01)

- Port published as `127.0.0.1:9000:9000` only.
- Telemetry: `SONAR_TELEMETRY_ENABLE=false` (property `sonar.telemetry.enable`; it is `sonar.properties`-only, so the
  UI/API cannot change it). Verified two ways: `GET /api/system/info` shows `sonar.telemetry.enable = false`, and the
  server log prints `Sharing of SonarQube statistics is disabled.` Check again after upgrades:
  `docker logs wilson-sonar | grep -i statistics`.
- `SONAR_UPDATECENTER_ACTIVATE=false` stops the update-center fetch (marketplace/plugin version check).
- The scanner runs on a Docker `--internal` network shared only with the server: it has no route to the internet.
  Source is mounted read-only from a staged copy that excludes `node_modules`, `dist`, `data/`, `demos/media`, `*.db`,
  `e2e/results`, `.verify`, `.env*`, `.git`, `.claude`.
- Docker pulls of the two images are the only network use, and happen once.

## Gotchas hit on the first run (Docker Desktop, 8 GB VM)

- A nearly full VM disk (>95%) puts Elasticsearch read-only and the server never reaches UP. `up.sh` disables the ES
  disk watermark; still, free some space (`docker builder prune`) if you can.
- VM memory is tight: server heaps are capped (web/CE 512m, ES 256m, container 2g) and the scanner uses 512m JVM plus
  1 GB Node. With defaults the kernel OOM-killed the JS/TS bridge ("bridge server is unresponsive"). Tune with
  `SCANNER_JAVA_MB`, `NODE_MB`; `NO_TYPECHECK=false` re-enables type-aware rules if you give Docker more RAM.
- Pointing the scanner at a tree containing `node_modules` is also what makes it heavy, hence the staged copy.

## Using it

```bash
scripts/sonar/up.sh
scripts/sonar/scan.sh /path/to/worktree wilson-something
less /private/tmp/claude-501/wilson-sonar/out/wilson-something/summary.md
scripts/sonar/down.sh          # --purge to wipe everything
```

Community Edition reports security-hotspot-style rules (S2245, S4036, S5443, S4790 ...) as VULNERABILITY issues, so
`hotspots.json` is usually empty; read `issues.json`. Expect noise: Math.random for ids, fixed-PATH spawns, /tmp
scratch paths. Triage against `specs/webmcp-threat-model.md` as `/security-gate` Step 2 describes.
