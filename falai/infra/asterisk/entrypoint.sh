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
export FALAI_CDR_URL="${FALAI_CDR_URL:-}"
export FALAI_CDR_SECRET="${FALAI_CDR_SECRET:-}"
if [ -z "${FALAI_CDR_URL}" ]; then
  echo '[entrypoint] AVISO: FALAI_CDR_URL vazio — as chamadas marcadas no telefone NAO sao contabilizadas'
fi

SUBST_VARS='${NAT_LINES} ${AMI_USER} ${AMI_PASSWORD} ${ARI_USER} ${ARI_PASSWORD} ${WS_PORT} ${FALAI_CDR_URL} ${FALAI_CDR_SECRET}'

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

# ─── RTP / ICE ────────────────────────────────────────────────────────────────
# O webphone (WebRTC) usa ICE. Dentro do Docker, o Asterisk só conhece o IP
# INTERNO do container (ex.: 192.168.16.2) e era esse o único candidato que
# anunciava:
#     a=candidate:Hc0a81002 1 UDP 2130706431 192.168.16.2 10078 typ host
# Esse endereço é inalcançável a partir do browser (no macOS o host não
# encaminha para a rede interna do Docker), por isso o ICE nunca fechava e não
# havia áudio em nenhum sentido — apesar de a chamada estabelecer.
#
# [ice_host_candidates] reescreve o endereço anunciado nos candidatos host para
# o endereço onde as portas RTP estão realmente publicadas. Não muda o socket:
# o Asterisk continua à escuta no IP do container, só ANUNCIA o outro.
# ",include_local_address" mantém também o candidato original — útil quando o
# cliente está na mesma rede do container (ex.: outro container).
#
# WEBRTC_MEDIA_ADDRESS permite separar isto do EXTERNAL_IP do trunk SIP:
# em produção são o mesmo IP público, em dev pode interessar divergir.
export WEBRTC_MEDIA_ADDRESS="${WEBRTC_MEDIA_ADDRESS:-${EXTERNAL_IP:-}}"

{
  echo "[general]"
  echo "rtpstart=${RTP_START}"
  echo "rtpend=${RTP_END}"
  # Explícito de propósito: sem ICE o webphone não estabelece media.
  echo "icesupport=yes"

  if [ -n "${WEBRTC_MEDIA_ADDRESS}" ]; then
    echo ""
    echo "[ice_host_candidates]"
    # O IP do container muda a cada recriação — tem de ser lido no arranque.
    for ip in $(hostname -I 2>/dev/null || true); do
      case "${ip}" in
        *:*|127.*) continue ;;  # IPv6 e loopback não interessam aqui
      esac
      echo "${ip} => ${WEBRTC_MEDIA_ADDRESS},include_local_address"
      echo "[entrypoint] ICE: candidato host ${ip} anunciado como ${WEBRTC_MEDIA_ADDRESS}" >&2
    done
  else
    echo "[entrypoint] ICE sem remapeamento (WEBRTC_MEDIA_ADDRESS/EXTERNAL_IP vazios) — o webphone só terá áudio se o browser alcançar o IP do container" >&2
  fi
} > /etc/asterisk/rtp.conf

echo "[entrypoint] a arrancar Asterisk — trunks/extensões gerados pela API em /etc/asterisk/generated"
exec asterisk -f -vvv -U asterisk -G asterisk
