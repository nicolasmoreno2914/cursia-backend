#!/bin/bash
# Restaura en el Moodle 4.5 local los 7 .mbz de muestra del flujo de creación (uno por estilo), verifica que el HTML que ve
# el estudiante tiene estilos en línea y borra los cursos de prueba. Uso: REPO=<árbol> DIR=<OUT/mbz> bash creation-flow-r78-moodle.sh
set -u
PHP=${PHP_BIN:-/opt/homebrew/bin/php}; M=$HOME/cursia-test-env/moodle-local; PS="$REPO/scripts/moodle/r76-visual-design.php"
ok=0; ko=0
for f in "$DIR"/*.mbz; do
  n=$(basename "$f" .mbz)
  out=$("$PHP" -d memory_limit=2048M -c "$M/php.ini" "$PS" --moodle="$M/source" --action=restore-new --file="$f" --categoryid=1 2>&1)
  id=$(printf '%s' "$out" | sed -n 's/.*Course ID: \([0-9]*\).*/\1/p' | head -1)
  if [ -z "$id" ]; then echo "❌ $n: restauración falló: $(printf '%s' "$out" | tail -3)"; ko=$((ko+1)); continue; fi
  js=$("$PHP" -d memory_limit=2048M -c "$M/php.ini" "$PS" --moodle="$M/source" --action=labels --courseid="$id" 2>/dev/null)
  stats=$(printf '%s' "$js" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=j.activities||[];const html=a.map(x=>JSON.stringify(x)).join("");console.log(a.length+" "+(html.match(/style=/g)||[]).length+" "+j.fullname)})' 2>&1)
  set -- $stats
  if [ "${1:-0}" -ge 8 ] && [ "${2:-0}" -gt 20 ]; then echo "✅ $n: restaurado en Moodle 4.5 (curso #$id, $1 actividades, $2 estilos en línea)"; ok=$((ok+1)); else echo "❌ $n: curso #$id con $stats"; ko=$((ko+1)); fi
  name=$(printf '%s' "$stats" | cut -d' ' -f3-)
  "$PHP" -c "$M/php.ini" "$PS" --moodle="$M/source" --action=delete --courseid="$id" --title="${name:0:30}" >/dev/null 2>&1
done
echo "$ok ok, $ko fail"; [ $ko -eq 0 ]
