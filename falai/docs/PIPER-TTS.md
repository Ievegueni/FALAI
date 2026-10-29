# Voz PT-PT local com Piper

O Falaí pode gerar a voz (TTS) localmente com o [Piper](https://github.com/rhasspy/piper)
e a voz portuguesa europeia **pt_PT-tugão** (masculina, qualidade média). Corre na própria
VPS, sem GPU e sem API paga. Substitui o ElevenLabs quando `TTS_PROVIDER=piper`.

Código: `packages/providers/src/tts/PiperTtsAdapter.ts` (Piper gera o WAV a 22 kHz e o
ffmpeg converte para 8 kHz mono PCM 16-bit, o formato de telefonia).

## 1. Instalar na VPS (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv ffmpeg

sudo mkdir -p /opt/piper
sudo chown "$USER" /opt/piper
python3 -m venv /opt/piper/venv
/opt/piper/venv/bin/pip install -U pip piper-tts
```

## 2. Baixar a voz PT-PT

O comando `piper.download_voices` dá 404 nesta voz (o nome tem "ã"), por isso baixa-se directo:

```bash
cd /opt/piper
B="https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_PT/tug%C3%A3o/medium"
curl -fL -o pt_PT-tugao-medium.onnx      "$B/pt_PT-tug%C3%A3o-medium.onnx"
curl -fL -o pt_PT-tugao-medium.onnx.json "$B/pt_PT-tug%C3%A3o-medium.onnx.json"
ls -la   # .onnx ~63 MB e .onnx.json ~5 KB
```

## 3. Testar antes de ligar ao Falaí

```bash
echo "Olá, bem-vindo ao Falaí. A sua chamada é importante para nós." \
  | /opt/piper/venv/bin/piper -m /opt/piper/pt_PT-tugao-medium.onnx -f /tmp/teste.wav
ffmpeg -y -loglevel error -i /tmp/teste.wav -ar 8000 -ac 1 -c:a pcm_s16le /tmp/teste-8k.wav
ls -la /tmp/teste*.wav   # ambos com tamanho > 0
```

Para ouvir, copia para o teu computador: `scp user@vps:/tmp/teste-8k.wav .`

## 4. Ligar ao Falaí

No `.env` do Falaí (o mesmo que a API e o worker lêem), acrescenta:

```
TTS_PROVIDER=piper
PIPER_BIN=/opt/piper/venv/bin/piper
PIPER_MODEL=/opt/piper/pt_PT-tugao-medium.onnx
```

Actualiza o código e reinicia:

```bash
cd /srv/projects/FALAI/falai      # confirmar o caminho no ecosystem.config.cjs
git pull
pnpm install
pnpm build
pm2 restart falai-api falai-worker
pm2 logs falai-api --lines 50     # sem erros de piper/ffmpeg
```

## 5. Notas

- Com `TTS_PROVIDER=piper` o `voiceId` gravado em campanhas/agentes é ignorado: há só uma voz.
- **As frases fixas (saudação, despedida, "um momento"...) ficam em cache no Redis sem prazo**,
  por isso continuam com a voz antiga. Antes do `pm2 restart`, apaga-as para serem regeneradas com o Piper:

  ```bash
  docker exec falai_redis sh -c "redis-cli --scan --pattern 'falai:audio_cache:*' | xargs -r redis-cli del"
  ```

  Campanhas de Script Fixo já criadas guardam o áudio gerado na altura: recria-as para ouvir a voz nova.
- Voltar ao ElevenLabs: apaga `TTS_PROVIDER` do `.env` e `pm2 restart falai-api falai-worker`.
- Se o utilizador do pm2 não for o dono de `/opt/piper`, garante permissão de leitura/execução:
  `sudo chmod -R a+rX /opt/piper`.
