# Probe 2.0

Voice edition of [Probe] — the same account-aware AWS troubleshooting assistant, but you **speak** instead of type.

Original Probe: Cognito + text chat + Lex.  
**Probe 2.0:** microphone → S3 → Whisper → Probe diagnostics → spoken reply (ElevenLabs).

## What stayed the same

- Read-only investigation of **your** AWS account
- Lambda deep-dive: config, CloudWatch Logs, metrics, CloudFormation (ported from Probe collectors)
- Resource listing (Lambda, S3, EC2, DynamoDB, SQS, SNS, API Gateway, log groups)
- CloudWatch alarms
- Evidence-first analysis — no invented log lines

## What’s new (voice)

1. Browser starts a conversation and records with `MediaRecorder` (silence ends each turn).
2. `POST /uploads` → short-lived S3 presigned PUT URL.
3. Browser uploads audio directly to S3.
4. `POST /process` with `objectKey` + chat history.
5. Lambda: transcribe → Probe tools if needed → spoken troubleshooting reply → ElevenLabs TTS → signed MP3 URL.
6. Browser plays the reply and keeps listening until you end the session.

```
Browser ──voice──► S3 ──► ProcessAudio
                           ├─ OpenAI STT
                           ├─ Probe tools (investigate_lambda, list_*, alarms)
                           ├─ OpenAI spoken RCA
                           └─ ElevenLabs TTS ──► browser
```

## Prerequisites

- Node.js 20+
- AWS SAM CLI + credentials
- Secrets Manager:
  - `cloud-companion/openai2`
  - `cloud-companion/elevenlabs2`
- ElevenLabs voice ID (default `cgSgspJ2msm6clMCkdW9`)

## Deploy

```bash
cd backend
npm install
cp samconfig.toml.example samconfig.toml   # edit stack name + secret names
npm run build
sam deploy --guided
```

Set `VITE_API_ENDPOINT` in `frontend/.env` to the `ApiEndpoint` stack output, then:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 → **Start conversation** → describe an AWS issue out loud.

## Security

- Private S3 bucket; short-lived presigned URLs
- API keys from Secrets Manager at runtime (never logged locally)
- Probe-parity **read-only** IAM for diagnostics
- Log/metric collection uses lookback + event caps
- No Cognito yet in 2.0 (text Probe still has JWT auth) — add before production sharing
