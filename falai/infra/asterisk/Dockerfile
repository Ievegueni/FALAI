# Motor SIP/media da prova de conceito (Etapa 1 do docs/PLANO-INDEPENDENCIA-PBX.txt).
#
# Ubuntu 24.04 LTS traz o Asterisk 20 LTS nos repositórios oficiais — evita
# depender de imagens de terceiros e mantém a construção reproduzível.
# NOTA: não usar Debian 12 (bookworm) — o Asterisk foi removido dessa versão.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      asterisk \
      asterisk-modules \
      gettext-base \
      sngrep \
      tcpdump \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Os ficheiros .conf do Asterisk não suportam variáveis de ambiente. O entrypoint
# gera-os a partir dos templates com envsubst, para que nenhum segredo fique em
# disco no repositório.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5060/udp 5060/tcp
EXPOSE 10000-10100/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
