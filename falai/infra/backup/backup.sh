#!/usr/bin/env bash
# Backup diário do Falaí — ver docs/CONTINUIDADE-DO-SERVICO.md.
#
#   - base de dados: pg_dump em formato custom (comprimido), com hash SHA-256
#   - ficheiros (gravações, anexos): cópia espelho por rsync, se FILES_DIRS
#   - apaga dumps com mais de RETENTION_DAYS dias
#   - cópia para fora da máquina, se OFFSITE_CMD (ex.: rclone, aws s3 cp)
#
# Agendar no cron, ex.: 30 2 * * * /opt/falai/infra/backup/backup.sh >> /var/log/falai-backup.log 2>&1
# O .env (ENCRYPTION_KEY, JWT_SECRET) NÃO vai aqui: guarda-se à parte, num cofre.
# Sem a ENCRYPTION_KEY as credenciais encriptadas da base de dados são irrecuperáveis.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-falai_postgres}"
PG_USER="${PG_USER:-falai}"
PG_DB="${PG_DB:-falai}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/falai}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
FILES_DIRS="${FILES_DIRS:-}"     # ex.: "/opt/falai/recordings /opt/falai/apps/api/uploads"
OFFSITE_CMD="${OFFSITE_CMD:-}"   # recebe o caminho do dump como $1, ex.: 'rclone copy "$1" remoto:falai-backups'

mkdir -p "$BACKUP_DIR"
stamp="$(date +%F_%H%M)"
dump="$BACKUP_DIR/falai_${stamp}.dump"

echo "[$(date "+%F %T")] a exportar ${PG_DB}…"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$dump.part"
mv "$dump.part" "$dump"   # só fica com o nome final se o dump acabou bem
sha256sum "$dump" > "$dump.sha256" 2>/dev/null || shasum -a 256 "$dump" > "$dump.sha256"
echo "[$(date "+%F %T")] dump: $dump ($(du -h "$dump" | cut -f1))"

for dir in $FILES_DIRS; do
  [ -d "$dir" ] || { echo "aviso: $dir não existe"; continue; }
  rsync -a --delete "$dir/" "$BACKUP_DIR/files/$(basename "$dir")/"
  echo "[$(date "+%F %T")] ficheiros: $dir"
done

find "$BACKUP_DIR" -maxdepth 1 -name 'falai_*.dump*' -mtime +"$RETENTION_DAYS" -print -delete

if [ -n "$OFFSITE_CMD" ]; then
  bash -c "$OFFSITE_CMD" _ "$dump"
  bash -c "$OFFSITE_CMD" _ "$dump.sha256"
  echo "[$(date "+%F %T")] cópia externa feita"
fi
echo "[$(date "+%F %T")] backup concluído"
