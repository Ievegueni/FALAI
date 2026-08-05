#!/bin/bash
# Gera a configuração a partir dos templates (substituindo as variáveis de
# ambiente) e arranca o Asterisk em primeiro plano.
#
# IMPORTANTE: os templates NÃO contêm segredos. Os trunks e extensões são
# gerados pela API do Falaí em /etc/asterisk/generated a partir da base de dados.
set -euo pipefail

export AMI_USER="${AMI_USER:-falai}"
export AMI_PASSWORD="${AMI_PASSWORD:?AMI_PASSWORD em falta — ver .env.example}"
export ARI_USER="${ARI_USER:-falai}"
export ARI_PASSWORD="${ARI_PASSWORD:?ARI_PASSWORD em falta — ver .env.example}"
export RTP_START="${RTP_START:-10000}"
export RTP_END="${RTP_END:-10100}"
export WS_PORT="${WS_PORT:-8089}"

# NAT: quando o Asterisk está atrás de router/Docker, precisa de anunciar o
# endereço público no SDP. Se EXTERNAL_IP estiver vazio, as linhas ficam
# comentadas (caso do servidor com IP público directo).
if [ -n "${EXTERNAL_IP:-}" ]; then
  export NAT_LINES="external_media_address=${EXTERNAL_IP}
external_signaling_address=${EXTERNAL_IP}"
  echo "[entrypoint] NAT activo — a anunciar ${EXTERNAL_IP} no SDP"
else
  export NAT_LINES="; sem NAT — IP directo"
  echo "[entrypoint] sem NAT configurado (EXTERNAL_IP vazio)"
fi

# ATENÇÃO: o dialplan do Asterisk usa a mesma sintaxe ${VAR} que o shell. Sem
# esta lista explícita, o envsubst esvaziaria ${EXTEN}, ${DIALSTATUS} e
# ${CALLERID(num)} — o dialplan deixaria de funcionar de forma silenciosa.
# Só as variáveis aqui listadas são substituídas; as do Asterisk ficam intactas.
SUBST_VARS='${NAT_LINES} ${AMI_USER} ${AMI_PASSWORD} ${ARI_USER} ${ARI_PASSWORD} ${WS_PORT}'

mkdir -p /etc/asterisk /etc/asterisk/generated
# Os dois ficheiros que a API gera. Criados vazios para o Asterisk arrancar
# mesmo antes do primeiro sync — sem eles, os #include falham e o dialplan não
# carrega de todo.
touch /etc/asterisk/generated/pjsip-falai.conf /etc/asterisk/generated/globals-falai.conf
for tpl in /templates/*.template; do
  out="/etc/asterisk/$(basename "${tpl}" .template)"
  envsubst "${SUBST_VARS}" < "${tpl}" > "${out}"
  chown asterisk:asterisk "${out}"
  chmod 640 "${out}"
  echo "[entrypoint] gerado ${out}"
done

cat <<EOF > /etc/asterisk/rtp.conf
[general]
rtpstart=${RTP_START}
rtpend=${RTP_END}
EOF

echo "[entrypoint] a arrancar Asterisk — trunks/extensões gerados pela API em /etc/asterisk/generated"
exec asterisk -f -vvv -U asterisk -G asterisk
