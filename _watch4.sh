#!/bin/bash
TOKEN="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"
OWNER="serkancakal204-byte"
API="https://api.github.com"
UP="https://uploads.github.com"
OUT="/tmp/claude-0/-root/e483abe8-ae5d-4aab-8285-3e696a7981da/scratchpad/vs"
RUN=33113246544
TAG="v0.1.0-rc3"
RID=378104593

# artifact belonging specifically to the rc3 run
find_art() {
  curl -s -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/actions/artifacts?per_page=20" \
  | python3 -c "
import sys,json
for a in json.load(sys.stdin).get('artifacts',[]):
    if a['name']=='voidshot-windows' and not a['expired'] and a['workflow_run']['id']==$RUN:
        print(a['id']); break
"
}

for i in $(seq 1 100); do
  ART=$(find_art)
  if [ -n "$ART" ]; then
    echo "=== rc3 artifact id=$ART (после ~$((i*30))s) ==="
    curl -sL -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/actions/artifacts/$ART/zip" -o "$OUT/art4.zip"
    rm -rf "$OUT/art4"; mkdir -p "$OUT/art4"
    (cd "$OUT/art4" && unzip -o ../art4.zip >/dev/null 2>&1)
    echo "содержимое:"; find "$OUT/art4" -type f -printf '  %s bytes  %p\n'

    # удалить СТАРЫЕ ассеты релиза rc3 (там сейчас ошибочный rc1-бинарь)
    echo "чищу старые ассеты релиза..."
    curl -s -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/releases/$RID/assets" \
    | python3 -c "import sys,json;[print(a['id']) for a in json.load(sys.stdin)]" \
    | while read AID; do
        curl -s -X DELETE -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/releases/assets/$AID" -o /dev/null -w "  deleted asset $AID: %{http_code}\n"
      done

    # залить ПРАВИЛЬНЫЕ
    for f in "voidshot.exe" "bundle/nsis/Voidshot_0.1.0_x64-setup.exe" "bundle/msi/Voidshot_0.1.0_x64_en-US.msi"; do
      nm=$(basename "$f")
      code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
        --data-binary @"$OUT/art4/$f" \
        "$UP/repos/$OWNER/voidshot/releases/$RID/assets?name=$nm")
      echo "  upload $nm: $code"
    done

    echo "=== ССЫЛКИ (rc3, правильный бинарь) ==="
    curl -s -H "Authorization: token $TOKEN" "$API/repos/$OWNER/voidshot/releases/$RID" \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('RELEASE:',d['html_url'])
for a in d.get('assets',[]): print('  ',a['name'],a['size'],'->',a['browser_download_url'])
"
    exit 0
  fi
  sleep 30
done
echo "=== TIMEOUT 50 мин ==="
