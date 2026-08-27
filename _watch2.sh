#!/bin/bash
TOKEN="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"
OWNER="serkancakal204-byte"
API="https://api.github.com"
UP="https://uploads.github.com"
OUT="/tmp/claude-0/-root/e483abe8-ae5d-4aab-8285-3e696a7981da/scratchpad/vs"
OLD=9658170938

find_art() {
  curl -s -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/actions/artifacts?per_page=15" \
  | python3 -c "
import sys,json
for a in json.load(sys.stdin).get('artifacts',[]):
    if a['name']=='voidshot-windows' and not a['expired'] and a['id']!=$OLD:
        print(a['id']); break
"
}

for i in $(seq 1 100); do
  ART=$(find_art)
  if [ -n "$ART" ]; then
    echo "=== новый artifact id=$ART (после ~$((i*30))s) ==="
    curl -sL -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/actions/artifacts/$ART/zip" -o "$OUT/art2.zip"
    rm -rf "$OUT/art2"; mkdir -p "$OUT/art2"
    (cd "$OUT/art2" && unzip -o ../art2.zip >/dev/null 2>&1)
    echo "содержимое:"; find "$OUT/art2" -type f -printf '  %s bytes  %p\n'

    # релиз rc2: создать, если нет — взять существующий
    RID=$(curl -s -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
      "$API/repos/$OWNER/voidshot/releases" \
      -d '{"tag_name":"v0.1.0-rc2","name":"Voidshot 0.1.0-rc2 — PrintScreen fix","prerelease":true,"body":"Фикс: PrintScreen открывает Voidshot (low-level hook ловит клавишу раньше Ножниц). Качай voidshot.exe. Автозапуск включается сам."}' \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or '')")
    if [ -z "$RID" ]; then
      RID=$(curl -s -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/releases/tags/v0.1.0-rc2" \
        | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
    fi
    echo "release id: $RID"

    for f in "voidshot.exe" "bundle/nsis/Voidshot_0.1.0_x64-setup.exe" "bundle/msi/Voidshot_0.1.0_x64_en-US.msi"; do
      nm=$(basename "$f")
      code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
        --data-binary @"$OUT/art2/$f" \
        "$UP/repos/$OWNER/voidshot/releases/$RID/assets?name=$nm")
      echo "  upload $nm: $code"
    done

    echo "=== ССЫЛКИ ==="
    curl -s -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/releases/$RID" \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('RELEASE:',d['html_url'])
for a in d.get('assets',[]): print('  ',a['name'],'->',a['browser_download_url'])
"
    exit 0
  fi
  sleep 30
done
echo "=== TIMEOUT 50 мин ==="
