#!/bin/bash
# Chamada de teste real, originada pelo motor (não por um softphone).
#
#   ./infra/asterisk/test-call.sh 923456789
#
# É o teste que interessa: prova que a PLATAFORMA consegue telefonar pela
# ANGOVOIP, que é o que as campanhas e o agente de IA vão fazer. Usa o ARI,
# exactamente como a API do Falaí.
#
# O número é enviado no formato definido em ASTERISK_DIAL_FORMAT (.env da raiz).
# Enquanto a ANGOVOIP não confirmar qual aceitam, o valor por omissão é o
# nacional de 9 dígitos.

set -uo pipefail
C=falai-asterisk
NUM="${1:-}"

if [ -z "${NUM}" ]; then
  echo "Uso: $0 <numero>   (ex.: $0 923456789)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARI_USER=$(grep -E '^ASTERISK_ARI_USER=' "${ROOT}/.env" | cut -d= -f2-)
ARI_PASSWORD=$(grep -E '^ASTERISK_ARI_PASSWORD=' "${ROOT}/.env" | cut -d= -f2-)
ARI_URL=$(grep -E '^ASTERISK_ARI_URL=' "${ROOT}/.env" | cut -d= -f2-)
: "${ARI_URL:=http://127.0.0.1:8088}"

# O endpoint do trunk é o que a API escreveu no dialplan — a mesma fonte, para
# não haver dois sítios a discordar sobre o nome.
# A saída do CLI vem indentada, daí não haver âncora no início da linha.
TRUNK=$(docker exec "${C}" asterisk -rx "dialplan show globals" 2>/dev/null \
        | grep -E 'TRUNK_ENDPOINT=' | cut -d= -f2- | tr -d ' ')

if [ -z "${TRUNK}" ]; then
  echo "✗ Sem trunk activo no dialplan."
  echo "  A API não sincronizou ainda, ou não há trunk activo no backoffice."
  exit 1
fi

echo "── Chamada de teste ───────────────────────────────────────"
echo "  Para:   ${NUM}"
echo "  Trunk:  ${TRUNK}"
echo

RES=$(curl -s -u "${ARI_USER}:${ARI_PASSWORD}" -XPOST \
  "${ARI_URL}/ari/channels?endpoint=PJSIP/${NUM}@${TRUNK}&app=falai&appArgs=teste&timeout=60")

if grep -q '"id"' <<< "${RES}"; then
  ID=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<< "${RES}" | head -1)
  echo "✓ Chamada originada — canal ${ID}"
  echo "  A acompanhar 15s (Ctrl-C para sair)..."
  for _ in $(seq 1 5); do
    sleep 3
    docker exec "${C}" asterisk -rx "core show channels concise" 2>/dev/null \
      | grep -q "${ID}" && echo "  ... em curso" || { echo "  ... terminada"; break; }
  done
else
  echo "✗ O motor recusou a chamada:"
  echo "${RES}"
  echo
  echo "  Causas comuns:"
  echo "   - endpoint errado (o trunk mudou de nome e o dialplan não recarregou)"
  echo "   - formato do número não aceite pela ANGOVOIP (ver ASTERISK_DIAL_FORMAT)"
  echo "   - conta sem saldo ou sem permissão de saída"
fi

echo
echo "── Últimos erros SIP ──────────────────────────────────────"
docker exec "${C}" asterisk -rx "core show channels" 2>/dev/null | tail -3
