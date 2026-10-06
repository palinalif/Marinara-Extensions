# add-voice — enroll a voice for VoxCPM2 without touching the Engine

## Why this is a script and not a capability package

VoxCPM2's server resolves the OpenAI-compatible `voice` parameter to a **directory
scan**:

```python
VOICE_ROOT = "/voices"
reference = f"{VOICE_ROOT}/{voice}/reference.wav"
...
for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
    if child.is_symlink() or not child.is_dir(): continue
    if not VOICE_ID_RE.fullmatch(child.name): continue
    reference = child / "reference.wav"
    if reference.is_file() and not reference.is_symlink(): result.append(child.name)
```

So "enrolling a voice" is **creating a folder containing `reference.wav`**. There is
no enrollment API, no registry, and no Engine-side state. VoxCPM2 is zero-shot from a
reference clip, which is why the fork's 635 lines of `custom-voice-*.ts` collapse into
this file.

A capability package would add a manifest, a route prefix, a panel, and a restart
cycle to do a filesystem write. It earns its keep only if you want in-browser
recording from inside Marinara; for "put a recording on the box and hear it in the
chat", a script is the honest shape.

## Layout on GaldraTurn (Unraid)

| Path | Role |
|---|---|
| `/mnt/user/ai-models/voice-references/` | the host directory; **this is where voices are written** |
| mounted read-only into `voxcpm2-server` as `/voices` | the server only ever reads it, so `:ro` is correct |
| `\\GaldraTurn\ai-models\voice-references` | the same folder over SMB, for dropping clips by hand |

Because the server lists voices per request, **a new folder is a voice immediately** —
no container restart, no Engine restart.

## What the server accepts

* **Voice id**: 1-64 letters, numbers, underscores, hyphens (`[A-Za-z0-9_-]{1,64}`).
  No dots, no spaces, no `@`, no `#`. The server strips anything else.
* **Directory**: a real directory, not a symlink.
* **File**: `reference.wav`, a real file, not a symlink.
* **Audio**: 16-bit PCM mono. The clips in production are 16 kHz, 24 kHz and 48 kHz,
  5-22 seconds. This tool normalizes everything to **mono 16-bit 16 kHz**.

## Usage

```sh
# List what is enrolled
python3 add-voice.py --list

# Enroll from a WAV (mono/stereo, 8-48 kHz). Non-WAV input needs ffmpeg.
python3 add-voice.py "Tony Stark" ./tony.wav

# Preview without writing, then write
python3 add-voice.py "Tony Stark" ./tony.wav --dry-run
python3 add-voice.py "Tony Stark" ./tony.wav

# Replace an existing voice (the old clip is kept as reference.wav.replaced)
python3 add-voice.py "Tony Stark" ./tony-new.wav --force

# Confirm the running server lists it
python3 add-voice.py --check "Tony Stark"

# Delete
python3 add-voice.py --remove "Tony Stark" --force

# Built-in checks (no server, no root needed)
python3 add-voice.py --selftest
```

Names are slugified: `"Tony Stark"` → `tony-stark`, `"Dr. Vex_9!"` → `dr-vex-9`.

## What the tool enforces

| Rule | Limit | Why |
|---|---|---|
| Duration floor | 1 s | a prompt with no speech clones nothing |
| Duration ceiling | 120 s | the fork's enrollment ceiling |
| Preferred length | ≤ 20 s (warns) | VoxCPM prompts get mushy past ~20 s; 5-15 s clones cleanest |
| Trim | `--max-seconds` (default 30) | long recordings are cut, not rejected |
| Bit depth | 16-bit PCM only | the server's prompts are 16-bit |
| Channels | mono or stereo in, mono out | stereo is downmixed |
| Sample rate in | 8-48 kHz | resampled to 16 kHz (linear interpolation) |
| Size | ≤ 10 MiB | the fork's enrollment ceiling |
| Silence | refused | peak normalization would amplify noise |
| Symlinks | refused | the server refuses them; refusing here gives a clear error |
| Existing voice | refused without `--force` | with `--force`, the old clip is kept as `reference.wav.replaced` |

Written files are mode `0644` so a non-root container user can read them.

## Pointing Marinara at it

Connections → **Text to Speech**:

| Field | Value |
|---|---|
| Source | **OpenAI-compatible** |
| Base URL | `http://host.docker.internal:3042/v1` |
| Model | `voxcpm` |
| API key | empty |
| Format | `wav` |

`TTS_LOCAL_URLS_ENABLED=true` must be set on the Engine for it to accept a local base
URL (this is separate from `WEBHOOK_LOCAL_URLS_ENABLED`, which is for custom tools).
Per-character voices are stock Engine behaviour — the picker lists whatever
`GET /v1/audio/voices` returns, so an enrolled folder appears there and can be assigned
to a character with no further setup.

## What this does not do

* **Voice design from a text description.** The fork's "VoxCPM2 auto-design" needs an
  endpoint this server does not expose (`/health`, `/generate`, `/generate-stable`,
  `/v1/audio/speech` are all it has). Deferred: add a design model later. It only
  affected Game mode.
* **Per-connection TTS configs.** The Engine has one active TTS config; the fork's
  `connectionId`/`legacyConfig` work has no seam. Switching voices means switching the
  global config.
* **Emotion as a parameter.** `/v1/audio/speech` takes `input`, `model`, `voice`,
  `speed`, `response_format`. Emotion is expressed as inline style tags in the text
  (`server.py`'s `style_instruction` / `split_style_segments`), not as a field.
