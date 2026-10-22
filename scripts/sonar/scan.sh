#!/usr/bin/env bash
# Usage: scan.sh <worktree-path> [project-key]   (server must be up: up.sh)
# Scanner runs on an --internal network (no internet) against a read-only staged copy of the source.
# Output: /private/tmp/claude-501/wilson-sonar/out/<project-key>/{issues.json,hotspots.json,summary.md}
set -euo pipefail
cd "$(dirname "$0")"; . ./common.sh
SRC="$(cd "${1:?usage: scan.sh <worktree-path> [project-key]}" && pwd -P)"
KEY="${2:-wilson-$(basename "$SRC")}"
PASS="$(cat "$SONAR_STATE/admin-password")"; TOKEN="$(cat "$SONAR_STATE/token")"
curl -fsS "$SONAR_URL/api/system/status" | grep -q '"UP"' || die "server not UP (run up.sh)"
curl -fsS -u "admin:$PASS" -X POST "$SONAR_URL/api/projects/create" --data-urlencode "project=$KEY" --data-urlencode "name=$KEY" >/dev/null 2>&1 || true

EXCL='**/node_modules/**,**/dist/**,**/data/**,**/demos/media/**,**/*.db,**/*.db-*,**/*.sqlite*,**/e2e/results/**,**/.verify/**,**/.git/**,**/.claude/**,**/.env*,**/*.min.js,**/coverage/**,**/.openaccountant*/**'
TESTEXCL='**/__tests__/**,**/*.test.ts,**/*.test.tsx'
# Stage a clean copy (no node_modules/dist/data/dbs/.env/.git). Pointing the scanner straight at a tree that has
# node_modules makes the JS/TS bridge die under amd64 emulation on Apple Silicon ("bridge server is unresponsive").
STAGE="$SONAR_STATE/stage/$KEY"; rm -rf "$STAGE"; mkdir -p "$STAGE"
rsync -a --prune-empty-dirs \
  --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='.claude' --exclude='data' --exclude='demos/media' \
  --exclude='*.db' --exclude='*.db-*' --exclude='*.sqlite*' --exclude='e2e/results' --exclude='.verify' --exclude='.env*' \
  --exclude='coverage' --exclude='.openaccountant*' --exclude='*.node' --exclude='*.png' --exclude='*.mp4' --exclude='*.gif' \
  "$SRC/" "$STAGE/"
SRCDIRS="src"; [ -d "$STAGE/scripts" ] && SRCDIRS="src,scripts"
TS_ARGS=()
[ -f "$STAGE/tsconfig.json" ] && TS_ARGS+=("-Dsonar.typescript.tsconfigPaths=tsconfig.json")

docker run --rm --network "$SONAR_NET_INT" \
  -v "$STAGE:/usr/src:ro" \
  -e SONAR_HOST_URL="http://${SONAR_NAME}:9000" -e SONAR_TOKEN="$TOKEN" \
  -e SONAR_SCANNER_JAVA_OPTS="-Xmx${SCANNER_JAVA_MB:-512}m" --platform linux/amd64 \
  "$SONAR_SCANNER_IMAGE" \
  -Dsonar.projectKey="$KEY" -Dsonar.projectBaseDir=/usr/src \
  -Dsonar.working.directory=/tmp/scannerwork \
  -Dsonar.sources="$SRCDIRS" -Dsonar.exclusions="$EXCL" \
  -Dsonar.test.inclusions="$TESTEXCL" \
  -Dsonar.scm.disabled=true -Dsonar.sourceEncoding=UTF-8 \
  -Dsonar.javascript.node.maxspace=${NODE_MB:-1024} -Dsonar.javascript.disableTypeChecking=${NO_TYPECHECK:-true} \
  -Dsonar.qualitygate.wait=true -Dsonar.qualitygate.timeout=600 \
  "${TS_ARGS[@]}" || echo "scanner exited non-zero (quality gate may have failed; collecting issues anyway)"

OUT="$SONAR_STATE/out/$KEY"; mkdir -p "$OUT"
api() { curl -fsS -u "admin:$PASS" "$SONAR_URL$1"; }
page() { # $1=endpoint-with-query $2=listkey ; paginates, prints merged JSON array
  python3 - "$SONAR_URL" "admin:$PASS" "$1" "$2" <<'PY'
import sys,json,base64,urllib.request
base,cred,ep,k=sys.argv[1:5]; out=[]; p=1
while True:
    r=urllib.request.Request(f"{base}{ep}&p={p}&ps=500",headers={"Authorization":"Basic "+base64.b64encode(cred.encode()).decode()})
    d=json.load(urllib.request.urlopen(r)); out+=d[k]
    if p*500>=d["paging"]["total"] or p>=20: break
    p+=1
print(json.dumps(out))
PY
}
page "/api/issues/search?componentKeys=$KEY&resolved=false" issues > "$OUT/issues.json"
page "/api/hotspots/search?project=$KEY&status=TO_REVIEW" hotspots > "$OUT/hotspots.json"
api "/api/qualitygates/project_status?projectKey=$KEY" > "$OUT/quality-gate.json" || true
api "/api/measures/component?component=$KEY&metricKeys=ncloc,bugs,vulnerabilities,security_hotspots,code_smells" > "$OUT/measures.json" || true

rm -rf "$STAGE"
python3 - "$OUT" "$KEY" "$SRC" > "$OUT/summary.md" <<'PY'
import sys,json,collections
out,key,src=sys.argv[1:4]
I=json.load(open(f"{out}/issues.json")); H=json.load(open(f"{out}/hotspots.json"))
def rel(c): return c.split(":",1)[-1]
print(f"# SonarQube local scan: {key}\n\nSource: `{src}`\n")
try:
    m={x["metric"]:x["value"] for x in json.load(open(f"{out}/measures.json"))["component"]["measures"]}; print("Measures:",m,"\n")
except Exception: pass
print(f"Issues: {len(I)}  Hotspots (TO_REVIEW): {len(H)}\n")
bytype=collections.Counter((i["type"],i["severity"]) for i in I)
print("## Issues by type/severity\n"); [print(f"- {t} / {s}: {n}") for (t,s),n in sorted(bytype.items())]
print("\n## Security-relevant and bug issues (non-test, BLOCKER..MAJOR)\n")
for i in sorted(I,key=lambda i:["BLOCKER","CRITICAL","MAJOR","MINOR","INFO"].index(i["severity"])):
    if i["type"] in("BUG","VULNERABILITY") or "security" in " ".join(i.get("tags",[])):
        print(f"- [{i['severity']}][{i['type']}] {rel(i['component'])}:{i.get('line','?')} `{i['rule']}` {i['message']}")
print("\n## Hotspots by rule\n")
byrule=collections.defaultdict(list)
for h in H: byrule[(h["vulnerabilityProbability"],h["ruleKey"],h["securityCategory"])].append(h)
for (p,r,c),hs in sorted(byrule.items(),key=lambda kv:(["HIGH","MEDIUM","LOW"].index(kv[0][0]),-len(kv[1]))):
    print(f"- [{p}] `{r}` ({c}) x{len(hs)}: {hs[0]['message']}")
    for h in hs[:5]: print(f"    - {rel(h['component'])}:{h.get('line','?')}")
PY
echo "wrote $OUT/{issues.json,hotspots.json,summary.md}"
