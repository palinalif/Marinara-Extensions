#!/usr/bin/env python3
"""
add-voice — enroll a character voice for VoxCPM2 by writing a reference clip.

VoxCPM2's OpenAI-compatible server resolves `voice` to a directory scan:

    VOICE_ROOT/<voice-id>/reference.wav

so enrollment is a filesystem operation, not an API call. This helper produces
files that server accepts: a slug-safe directory name (1-64 letters, numbers,
underscores, hyphens) containing a real file (never a symlink) named
reference.wav, mono 16-bit PCM.

Defaults mirror the clips already working on GaldraTurn (mono, 16-bit,
16 kHz, 5-22 s). Input may be any format ffmpeg can decode; .wav input is
handled with the standard library alone, so the tool works on a bare host.

Usage:
    add-voice.py <name> <input-audio> [--force] [--dry-run] [--rate 16000]
    add-voice.py --list
    add-voice.py --check <name>
    add-voice.py --remove <name> --force
    add-voice.py --selftest
"""

from __future__ import annotations

import argparse
import array
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import wave

# ── Limits ────────────────────────────────────────────────────────────────
# The server's own gate: 1-64 letters/numbers/underscore/hyphen, no symlinks.
VOICE_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

MAX_BYTES = 10 * 1024 * 1024          # 10 MiB, the fork's enrollment ceiling
MAX_SECONDS = 120.0                   # the fork's enrollment ceiling
PREFERRED_MAX_SECONDS = 20.0          # VoxCPM prompts get mushy past ~20 s
MIN_SECONDS = 1.0
MIN_INPUT_RATE = 8000
MAX_INPUT_RATE = 48000
DEFAULT_RATE = 16000
PEAK_TARGET = 0.89                    # -1 dBFS; keeps the model out of clipping

ROOT_DEFAULT = "/mnt/user/ai-models/voice-references"
VOICES_URL_DEFAULT = "http://127.0.0.1:3042/v1/audio/voices"


class VoiceError(Exception):
    """A rejection. Message is user-facing; never includes file contents."""


# ── Naming ────────────────────────────────────────────────────────────────

def slugify(raw: str) -> str:
    """Turn a display name into a server-safe voice id."""
    value = (raw or "").strip().lower()
    value = re.sub(r"[\s_]+", "-", value)
    value = re.sub(r"[^a-z0-9-]", "", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    value = value[:64]
    if not value:
        raise VoiceError(f"Name {raw!r} has no usable letters or digits")
    if not VOICE_ID_RE.fullmatch(value):
        raise VoiceError(f"Name {raw!r} slugs to {value!r}, which the server rejects")
    return value


# ── Reading ───────────────────────────────────────────────────────────────

def ffmpeg_to_wav(source: str) -> str:
    """Decode any media file to a temporary 16-bit PCM wav. Returns its path."""
    binary = shutil.which("ffmpeg")
    if not binary:
        raise VoiceError(
            f"{source} is not a .wav file and ffmpeg is not installed; "
            "convert it to WAV (mono, 16-bit, 16-48 kHz) first"
        )
    handle, target = tempfile.mkstemp(suffix=".wav")
    os.close(handle)
    command = [binary, "-hide_banner", "-loglevel", "error", "-y", "-i", source,
               "-ac", "1", "-sample_fmt", "s16", target]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        os.unlink(target)
        detail = (result.stderr or "").strip()[:300]
        raise VoiceError(f"ffmpeg failed to decode {source}: {detail}")
    return target


def read_wav(path: str) -> tuple[int, int, array.array]:
    """Return (rate, channels, samples) for a 16-bit PCM wav."""
    try:
        with wave.open(path, "rb") as source:
            channels = source.getnchannels()
            rate = source.getframerate()
            width = source.getsampwidth()
            frames = source.getnframes()
            code = source.getcomptype()
            raw = source.readframes(frames)
    except wave.Error as error:
        raise VoiceError(f"Not a readable WAV file: {error}") from error

    if code != "NONE":
        raise VoiceError(f"Only uncompressed PCM is accepted, got compression {code!r}")
    if width != 2:
        raise VoiceError(f"Only 16-bit PCM is accepted, got {width * 8}-bit")
    if channels not in (1, 2):
        raise VoiceError(f"Only mono or stereo is accepted, got {channels} channels")
    if rate < MIN_INPUT_RATE or rate > MAX_INPUT_RATE:
        raise VoiceError(f"Sample rate {rate} Hz is outside {MIN_INPUT_RATE}-{MAX_INPUT_RATE} Hz")

    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
    return rate, channels, samples


# ── Processing ────────────────────────────────────────────────────────────

def to_mono(channels: int, samples: array.array) -> array.array:
    if channels == 1:
        return samples
    mono = array.array("h", [0] * (len(samples) // channels))
    for index in range(len(mono)):
        total = sum(samples[index * channels + voice] for voice in range(channels))
        mono[index] = int(total / channels)
    return mono


def resample(mono: array.array, rate: int, target: int) -> array.array:
    """Linear interpolation. Good enough for a voice prompt, stdlib-only."""
    if rate == target or len(mono) == 0:
        return mono
    ratio = rate / target
    length = int(len(mono) / ratio)
    out = array.array("h", [0] * length)
    last = len(mono) - 1
    for index in range(length):
        position = index * ratio
        left = int(position)
        right = min(left + 1, last)
        weight = position - left
        out[index] = int(mono[left] * (1.0 - weight) + mono[right] * weight)
    return out


def peak_normalize(mono: array.array, target: float = PEAK_TARGET) -> array.array:
    peak = max((abs(sample) for sample in mono), default=0)
    if peak <= 0:
        raise VoiceError("Audio is silent; a voice reference needs speech in it")
    ceiling = 32767.0 * target
    if peak <= ceiling:
        return mono
    gain = ceiling / peak
    out = array.array("h", [0] * len(mono))
    for index, sample in enumerate(mono):
        out[index] = max(-32768, min(32767, int(sample * gain)))
    return out


def trim(mono: array.array, rate: int, max_seconds: float) -> array.array:
    limit = int(rate * max_seconds)
    return mono[:limit]


# ── Writing ───────────────────────────────────────────────────────────────

def write_reference(mono: array.array, rate: int, root: str, voice_id: str,
                    dry_run: bool, force: bool) -> str:
    target_dir = os.path.join(root, voice_id)
    reference = os.path.join(target_dir, "reference.wav")

    if os.path.islink(target_dir):
        raise VoiceError(f"{target_dir} is a symlink; the server refuses symlinked voices")
    if os.path.islink(reference):
        raise VoiceError(f"{reference} is a symlink; the server refuses symlinked references")
    if os.path.exists(reference) and not force:
        raise VoiceError(f"{voice_id} already has a reference; pass --force to replace it")

    # Stage in the destination filesystem so the copy is same-filesystem, but a
    # dry run must not touch the voice root at all.
    staging = root
    if dry_run:
        staging = tempfile.gettempdir()
    else:
        os.makedirs(root, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=".add-voice-", dir=staging)
    try:
        with os.fdopen(handle, "wb") as sink:
            with wave.open(sink, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(rate)
                output.writeframes(mono.tobytes())
        if not dry_run:
            os.makedirs(target_dir, exist_ok=True)
            if os.path.exists(reference):
                backup = os.path.join(target_dir, "reference.wav.replaced")
                shutil.copy2(reference, backup)
            shutil.copy2(temp, reference)
            # mkstemp creates 0600; the voxcpm2 container must be able to read it.
            os.chmod(reference, 0o644)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return reference


# ── Verification ──────────────────────────────────────────────────────────

def verify(voice_id: str, url: str) -> str:
    """Ask the running server whether it now lists the voice."""
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            body = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as error:
        return f"unreachable ({error})"
    except Exception as error:  # noqa: BLE001 - verification is advisory
        return f"unreachable ({error})"
    listed = re.findall(r'"id"\s*:\s*"([^"]+)"', body)
    if voice_id in listed:
        return f"listed by the server ({len(listed)} voices)"
    return f"NOT listed by the server ({len(listed)} voices) — restart voxcpm2-server?"


def describe(root: str, voice_id: str) -> str:
    reference = os.path.join(root, voice_id, "reference.wav")
    if not os.path.isfile(reference):
        return f"{voice_id}: no reference.wav"
    rate, channels, samples = read_wav(reference)
    seconds = len(samples) / channels / rate
    size = os.path.getsize(reference)
    return f"{voice_id}: {channels}ch 16bit {rate} Hz {seconds:.2f}s {size / 1024:.0f} KiB"


# ── Commands ──────────────────────────────────────────────────────────────

def cmd_add(args: argparse.Namespace) -> int:
    voice_id = slugify(args.name)
    decoded = ffmpeg_to_wav(args.input) if not args.input.lower().endswith(".wav") else args.input
    try:
        rate, channels, samples = read_wav(decoded)
        mono = to_mono(channels, samples)
        seconds = len(mono) / rate
        if seconds > MAX_SECONDS:
            raise VoiceError(f"{seconds:.1f}s of audio; the ceiling is {MAX_SECONDS}s")
        if seconds < MIN_SECONDS:
            raise VoiceError(f"{seconds:.2f}s of audio; a reference needs at least {MIN_SECONDS}s")
        mono = trim(mono, rate, args.max_seconds)
        mono = resample(mono, rate, args.rate)
        mono = peak_normalize(mono)
        seconds = len(mono) / args.rate
        if len(mono) * 2 > MAX_BYTES:
            raise VoiceError(f"Result is {len(mono) * 2 / 1024 / 1024:.1f} MiB; ceiling is 10 MiB")
        if seconds > PREFERRED_MAX_SECONDS:
            print(f"  note: {seconds:.1f}s is long for a prompt; ~5-15s clones cleanest")
        path = write_reference(mono, args.rate, args.root, voice_id, args.dry_run, args.force)
    finally:
        if decoded != args.input and os.path.exists(decoded):
            os.unlink(decoded)

    verb = "would write" if args.dry_run else "wrote"
    print(f"{verb} {path}")
    print(f"  {voice_id}: 1ch 16bit {args.rate} Hz {seconds:.2f}s")
    if not args.dry_run and not args.no_verify:
        print(f"  server: {verify(voice_id, args.voices_url)}")
    print(f"  Marinara → Connections → Text to Speech → voice picker: {voice_id}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    if not os.path.isdir(args.root):
        raise VoiceError(f"Voice root {args.root} is not a directory")
    names = sorted(
        entry.name for entry in os.scandir(args.root)
        if entry.is_dir() and not entry.is_symlink() and VOICE_ID_RE.fullmatch(entry.name)
    )
    for name in names:
        print(describe(args.root, name))
    print(f"{len(names)} voices in {args.root}")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    voice_id = slugify(args.name)
    print(describe(args.root, voice_id))
    print(f"  server: {verify(voice_id, args.voices_url)}")
    return 0


def cmd_remove(args: argparse.Namespace) -> int:
    voice_id = slugify(args.name)
    target = os.path.join(args.root, voice_id)
    if not os.path.isdir(target):
        raise VoiceError(f"{voice_id} is not an enrolled voice")
    if not args.force:
        raise VoiceError(f"Removing {voice_id} deletes its reference; pass --force")
    shutil.rmtree(target)
    print(f"removed {target}")
    return 0


# ── Self-test ─────────────────────────────────────────────────────────────

def cmd_selftest(_args: argparse.Namespace) -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, pass_: bool, detail: str = "") -> None:
        results.append((name, pass_, detail))
        print(f"{'PASS' if pass_ else 'FAIL'}  {name}{f'  — {detail}' if detail else ''}")

    # Naming
    check("slug: spaces and case", slugify("Tony Stark") == "tony-stark")
    check("slug: punctuation dropped", slugify("Dr. Vex_9!") == "dr-vex-9")
    check("slug: 64 cap", len(slugify("a" * 200)) == 64)
    try:
        slugify("!!!")
        check("slug: unusable name rejected", False)
    except VoiceError:
        check("slug: unusable name rejected", True)

    # Audio pipeline
    rate, channels, samples = read_wav(_make_wav(44100, 2, 1.0))
    check("wav: reads stereo 44.1k", channels == 2 and rate == 44100)
    mono = to_mono(channels, samples)
    check("mono: channel count", len(mono) == len(samples) // 2)
    down = resample(mono, 44100, 16000)
    check("resample: length ratio", abs(len(down) / len(mono) - 16000 / 44100) < 0.01,
          f"{len(down)} from {len(mono)}")
    loud = peak_normalize(array.array("h", [32767, -32767, 16384]))
    check("normalize: peak lands under ceiling", max(abs(s) for s in loud) <= 32767 * PEAK_TARGET + 1)
    silent = array.array("h", [0] * 100)
    try:
        peak_normalize(silent)
        check("normalize: silent audio rejected", False)
    except VoiceError:
        check("normalize: silent audio rejected", True)
    check("trim: honours ceiling", len(trim(mono, 44100, 0.5)) == int(44100 * 0.5))

    # Writing and the server's filesystem rules
    with tempfile.TemporaryDirectory() as root:
        path = write_reference(down, 16000, root, "tony-stark", False, False)
        check("write: reference.wav created", os.path.isfile(path))
        check("write: file is a real file, not a symlink", not os.path.islink(path))
        check("write: describe round-trips", "16000 Hz" in describe(root, "tony-stark"),
              describe(root, "tony-stark"))
        try:
            write_reference(down, 16000, root, "tony-stark", False, False)
            check("write: refuses to clobber without --force", False)
        except VoiceError:
            check("write: refuses to clobber without --force", True)
        write_reference(down, 16000, root, "tony-stark", False, True)
        check("write: --force keeps a backup",
              os.path.isfile(os.path.join(root, "tony-stark", "reference.wav.replaced")))
        check("write: dry run creates nothing",
              write_reference(down, 16000, root, "ghost", True, False)
              and not os.path.exists(os.path.join(root, "ghost", "reference.wav")))
        link = os.path.join(root, "symlinked")
        os.symlink(os.path.join(root, "tony-stark"), link)
        try:
            write_reference(down, 16000, root, "symlinked", False, True)
            check("write: symlinked voice dir rejected", False)
        except VoiceError:
            check("write: symlinked voice dir rejected", True)

    # Rejections the server would also enforce
    check("gate: 120s ceiling", _over_ceiling(8000, 1, 121.0))
    check("gate: 1s floor", _under_floor(8000, 1, 0.5))
    check("gate: 8-bit rejected", _rejects_bits() is True)
    check("gate: 7999 Hz rejected", _rejects_rate(7999))

    failed = [name for name, pass_, _ in results if not pass_]
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


def _make_wav(rate: int, channels: int, seconds: float) -> str:
    handle, path = tempfile.mkstemp(suffix=".wav")
    os.close(handle)
    frames = int(rate * seconds)
    with wave.open(path, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        tone = array.array("h", [
            int(12000 * math.sin(2 * math.pi * 220 * index / rate)) for index in range(frames)
        ])
        interleaved = array.array("h")
        for index in range(frames):
            for _ in range(channels):
                interleaved.append(tone[index])
        output.writeframes(interleaved.tobytes())
    return path


def _duration(rate: int, channels: int, seconds: float) -> float:
    path = _make_wav(rate, channels, seconds)
    try:
        _, channels_read, samples = read_wav(path)
        return len(to_mono(channels_read, samples)) / rate
    finally:
        os.unlink(path)


def _over_ceiling(rate: int, channels: int, seconds: float) -> bool:
    return _duration(rate, channels, seconds) > MAX_SECONDS


def _under_floor(rate: int, channels: int, seconds: float) -> bool:
    return _duration(rate, channels, seconds) < MIN_SECONDS


def _rejects_bits() -> bool:
    """A 24-bit wav is refused: the server's prompts are 16-bit PCM."""
    handle, path = tempfile.mkstemp(suffix=".wav")
    os.close(handle)
    try:
        with wave.open(path, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(3)
            output.setframerate(16000)
            output.writeframes(bytes(16000 * 3))
        read_wav(path)
        return False
    except VoiceError:
        return True
    finally:
        if os.path.exists(path):
            os.unlink(path)


def _rejects_rate(rate: int) -> bool:
    path = _make_wav(rate, 1, 2.0)
    try:
        read_wav(path)
        return False
    except VoiceError:
        return True
    finally:
        os.unlink(path)


# ── Entry ─────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--root", default=ROOT_DEFAULT, help="Host path mounted as /voices")
    parser.add_argument("--voices-url", default=VOICES_URL_DEFAULT,
                        help="Server endpoint used to confirm the voice is listed")
    parser.add_argument("--rate", type=int, default=DEFAULT_RATE, help="Output sample rate")
    parser.add_argument("--max-seconds", type=float, default=30.0, help="Trim longer clips")
    parser.add_argument("--force", action="store_true", help="Replace an existing reference")
    parser.add_argument("--dry-run", action="store_true", help="Validate without writing")
    parser.add_argument("--no-verify", action="store_true", help="Skip the server check")
    parser.add_argument("--list", action="store_true", help="List enrolled voices")
    parser.add_argument("--check", metavar="NAME", help="Report one voice's spec")
    parser.add_argument("--remove", metavar="NAME", help="Delete one voice")
    parser.add_argument("--selftest", action="store_true", help="Run built-in checks")
    parser.add_argument("name", nargs="?", help="Voice name (slugified into the voice id)")
    parser.add_argument("input", nargs="?", help="WAV, or any file ffmpeg can decode")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.selftest:
            return cmd_selftest(args)
        if args.list:
            return cmd_list(args)
        if args.check:
            args.name = args.check
            return cmd_check(args)
        if args.remove:
            args.name = args.remove
            return cmd_remove(args)
        if not args.name or not args.input:
            build_parser().print_help()
            return 2
        return cmd_add(args)
    except VoiceError as error:
        print(f"refused: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
