#!/usr/bin/env bash
# Teste de restauro — prova que o último backup se recupera, sem tocar na
# produção: restaura num Postgres temporário à parte e conta registos.
# Correr pelo menos uma vez por mês e guardar o resultado (ver
# docs/CONTINUIDADE-DO-SERVICO.md). Um backup nunca restaurado não é um backup.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/backups/falai}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"
dump="${1:-$(ls -1t "$BACKUP_DIR"/falai_*.dump | head -1)}"
[ -f "$dump" ] || { echo "sem dump em $BACKUP_DIR"; exit 1; }

if [ -f "$dump.sha256" ]; then
  (cd "$(dirname "$dump")" && (sha256sum -c "$(basename "$dump").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$dump").sha256")) || { echo "FALHOU: hash não confere"; exit 1; }
fi

name="falai_restore_test_$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -e POSTGRES_PASSWORD=teste -e POSTGRES_USER=falai -e POSTGRES_DB=falai "$PG_IMAGE" >/dev/null
for _ in $(seq 1 30); do docker exec "$name" pg_isready -U falai >/dev/null 2>&1 && break; sleep 1; done

start=$(date +%s)
docker exec -i "$name" pg_restore -U falai -d falai --no-owner < "$dump"
secs=$(( $(date +%s) - start ))

q() { docker exec "$name" psql -U falai -d falai -Atc "$1"; }
echo "Restauro de $(basename "$dump") em ${secs}s"
echo "  migrações aplicadas: $(q 'select count(*) from "_prisma_migrations"')"
for t in Tenant TenantUser Contact Call Ticket Conversation; do
  echo "  $t: $(q "select count(*) from \"$t\"")"
done
echo "OK — backup recuperável"
