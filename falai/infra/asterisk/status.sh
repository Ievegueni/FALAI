#!/bin/bash
# Estado da ligação ao servidor SIP da ANGOVOIP.
#   ./infra/asterisk/status.sh
#
# É o "registado / não registado" que o IT da ANGOVOIP pediu. Enquanto o motor
# não estiver ligado à API (Etapa 3 do plano), este é o sítio para ver.

set -uo pipefail
C=falai-asterisk

if ! docker ps --format '{{.Names}}' | grep -q "^${C}$"; then
  echo "✗ NÃO REGISTADO — o contentor ${C} não está a correr."
  echo "  Arrancar: docker compose -f infra/asterisk/docker-compose.yml up -d"
  exit 1
fi

REG=$(docker exec "${C}" asterisk -rx "pjsip show registrations" 2>/dev/null)

echo "══════════════════════════════════════════════════════════"
if grep -q "Registered" <<< "${REG}"; then
  EXP=$(grep -oE 'exp\. [0-9]+s' <<< "${REG}" | head -1)
  echo "  ✓ REGISTADO na ANGOVOIP   (${EXP:-validade desconhecida})"
else
  echo "  ✗ NÃO REGISTADO"
  echo "    Causas comuns: password errada, IP fora da allowlist,"
  echo "    ou 5060/udp bloqueado. Ver README.md → Diagnóstico."
fi
echo "══════════════════════════════════════════════════════════"
echo
echo "${REG}" | grep -E "angovoip|Status" || true
echo
echo "── Chamadas em curso ──────────────────────────────────────"
docker exec "${C}" asterisk -rx "core show channels" 2>/dev/null | tail -4
echo
echo "── Softphones registados ──────────────────────────────────"
docker exec "${C}" asterisk -rx "pjsip show contacts" 2>/dev/null | grep -vE "^$|Objects" | tail -5
