# set-tts — connect Marinara Engine to VoxCPM2

Configures the Engine's **Text to Speech** to speak through a VoxCPM2 server
(OpenAI-compatible `/v1/audio/speech`), then proves it by making the Engine
synthesize a line.

```sh
docker cp /mnt/user/appdata/webfetch-proxy/Marinara-Extensions/tools/set-tts/set-tts.mjs marinara:/tmp/set-tts.mjs
docker exec marinara node /tmp/set-tts.mjs
```

Expected output:

```
Current:  enabled=false  source=elevenlabs  baseUrl=…  model=…  voice=…  audioFormat=mp3  speed=1
Planned:  enabled=true  source=openai  baseUrl=http://host.docker.internal:3042/v1  model=voxcpm  voice=tomori  audioFormat=wav  speed=1
Saved:    enabled, source, baseUrl, model, voice, audioFormat
Verified: enabled=true  source=openai  …
Voices:   aphel, lilya, nerine, rina, temari, tomori, tony
Speech:   118092 bytes, audio/wav
The Engine can speak through this connection.
```

## Modes

| Command | Effect |
|---|---|
| `node set-tts.mjs` | Configure, then verify voices + a real synthesis |
| `--dry-run` | Show the intended change, write nothing |
| `--show` | Print current TTS settings only |
| `--voices` | List voices the configured provider offers |
| `--speak "text" [--out line.wav]` | Synthesize a line through the Engine |
| `--selftest` | Run 17 checks against a built-in mock Engine |

Defaults: `--engine http://127.0.0.1:7860`, `--base-url http://host.docker.internal:3042/v1`,
`--model voxcpm`, `--voice tomori`, `--format wav`.

## Why the API, not the data files

TTS settings live in the Engine's `app_settings` table, which the running server holds in
memory and rewrites on every change — editing that file under a live server races it.
`PUT /api/tts/config` is the Engine's own validated write path, and loopback requests are
exempt from Basic Auth (`middleware/basic-auth.ts:323`) and CSRF
(`middleware/csrf-protection.ts:113`), so this runs inside the Engine container with no
credentials.

The config is **read, merged, and written back**, never replaced wholesale:
`GET /api/tts/config` returns the stored config with provider keys masked, and sending that
mask back keeps the stored key (`routes/tts.routes.ts:1349`). Narrator settings, dialogue
settings, per-character voice assignments, voice mode, and per-source profiles all survive.
The selftest asserts exactly that.

## Two things this tool will not let you get wrong

1. **Format must be `wav` or `pcm`.** VoxCPM2's `/v1/audio/speech` rejects every other
   `response_format` (`server.py:674`), and the Engine's default is `mp3`
   (`tts.routes.ts:1656`). `--format mp3` is refused before anything is sent.
2. **Local base URLs need a flag.** If the Engine refuses `host.docker.internal`, it needs
   `TTS_LOCAL_URLS_ENABLED=true` in the container's environment, then a restart. The voice
   discovery step prints that hint when it fails.

## Add a voice, then assign it

Enrollment is a folder on the share — see [`../add-voice/README.md`](../add-voice/README.md):

```sh
ADDVOICE="python3 /mnt/user/appdata/webfetch-proxy/Marinara-Extensions/tools/add-voice/add-voice.py"
$ADDVOICE "Tony Stark" /mnt/user/ai-staging/clips/tony.wav
```

The new voice appears in `--voices` immediately (no restart). Assigning it per character is
the stock Engine feature: **Character Editor → voice picker**, which writes
`voiceAssignments` and leaves every other TTS setting as stored.
