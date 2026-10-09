import atexit
import base64
import io
import json
import queue
import os
import socket
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from importlib import import_module
from pathlib import Path

from config import (
    log, TTS_ENABLED_DEFAULT, TTS_VOICE_PATH, TTS_ONNX_MODEL_DIR, TTS_ONNX_DTYPE,
    TTS_ONNX_PROVIDER, TTS_KOKORO_MODEL_PATH, TTS_KOKORO_VOICES_PATH,
    TTS_KOKORO_VOICE, TTS_KOKORO_LANGUAGE, TTS_MAX_NEW_TOKENS, TTS_TEMPERATURE,
    TTS_TOP_K, TTS_TOP_P, TTS_REPETITION_PENALTY, TTS_GREEDY, TTS_VOICES_DIR,
    TTS_VOICE_EXTS, TTS_OUTPUT_DEVICE, TTS_ENGINE_DEFAULT, TTS_FISH_ENDPOINT,
    TTS_FISH_TIMEOUT, TTS_FISH_REFERENCE_AUDIO, TTS_FISH_REFERENCE_TEXT,
    TTS_F5_PYTHON, TTS_F5_MODEL, TTS_F5_DEVICE, TTS_F5_REFERENCE_AUDIO,
    TTS_F5_REFERENCE_TEXT, TTS_F5_STARTUP_TIMEOUT, TTS_F5_TIMEOUT,
    onnxruntime_preloaded,
)
from state import state
from broadcast import broadcast_sync

SAMPLE_RATE_TTS = 24_000
START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299
TTS_ENGINE_NAMES = {
    "chatterbox": "Chatterbox Nano",
    "kokoro": "Kokoro",
    "fish_s2_gguf": "Fish S2 Pro (GGUF)",
    "f5_tts": "F5-TTS",
}
TTS_REFERENCE_TEXT_LOCK = threading.Lock()
KOKORO_VOICES = (
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa",
)


def _tts_broadcast() -> None:
    broadcast_sync({"type": "tts_state", "tts": state.tts_state()})


def _tts_queue_length() -> int:
    work_queue = state.tts_queue
    if work_queue is None:
        return 0
    with work_queue.mutex:
        return sum(1 for text, _voice, _reference_text in work_queue.queue if text is not None)


def _tts_list_output_devices() -> list[dict]:
    import sounddevice as sd

    devices = [
        {"id": index, "name": str(info["name"])}
        for index, info in enumerate(sd.query_devices())
        if int(info["max_output_channels"]) > 0
    ]
    tstate = state.tts_state()
    available = {device["id"] for device in devices}
    selected = tstate.get("output_device")
    if selected is not None and selected not in available:
        log.warning("[tts] selected output device %r is no longer available", selected)
        selected = None

    if selected is None and not tstate.get("output_device_override") and TTS_OUTPUT_DEVICE:
        try:
            configured = int(TTS_OUTPUT_DEVICE)
        except ValueError:
            configured = None
        if configured in available:
            selected = configured

    tstate["output_device"] = selected
    tstate["output_device_name"] = next(
        (device["name"] for device in devices if device["id"] == selected),
        "System default",
    )
    tstate["output_devices"] = devices
    tstate["output_error"] = "" if devices else "No audio output devices are available"
    return devices


def _tts_graph_path(model_dir, component: str, dtype: str):
    from pathlib import Path
    model_dir = Path(model_dir)
    suffix = "" if dtype == "fp32" else "_quantized" if dtype == "q8" else f"_{dtype}"
    candidates = [model_dir / "onnx" / f"{component}{suffix}.onnx"]
    if dtype == "q4f16" and component == "embed_tokens":
        candidates.append(model_dir / "onnx" / "embed_tokens_fp16.onnx")
    if dtype == "q4f16" and component == "conditional_decoder":
        candidates.append(model_dir / "onnx" / "conditional_decoder_q4.onnx")
    for candidate in candidates:
        if candidate.exists():
            return candidate
    fallback = model_dir / "onnx" / f"{component}.onnx"
    if fallback.exists():
        return fallback
    expected = ", ".join(str(p) for p in (*candidates, fallback))
    raise FileNotFoundError(f"missing component graph; checked {expected}")


def _tts_make_session(path, provider: str):
    ort = onnxruntime_preloaded
    if ort is None:
        import onnxruntime as ort
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if provider == "cuda" else ["CPUExecutionProvider"]
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=options, providers=providers)


def _tts_empty_cache(session, batch_size: int) -> dict:
    import numpy as np
    cache = {}
    for value in session.get_inputs():
        if not value.name.startswith("past_key_values."):
            continue
        dtype = np.float16 if value.type == "tensor(float16)" else np.float32
        heads = value.shape[1] if isinstance(value.shape[1], int) else 12
        head_dim = value.shape[3] if isinstance(value.shape[3], int) else 64
        cache[value.name] = np.zeros((batch_size, heads, 0, head_dim), dtype=dtype)
    if len(cache) != 24:
        raise RuntimeError(f"expected 24 nano kv-cache inputs, found {len(cache)}")
    return cache


def _tts_repetition_penalty(logits, generated, penalty: float):
    import numpy as np
    if penalty == 1.0:
        return logits
    result = logits.copy()
    token_ids = np.unique(generated)
    values = result[:, token_ids]
    result[:, token_ids] = np.where(values < 0, values * penalty, values / penalty)
    return result


def _tts_sample_token(logits, rng, temperature: float, top_k: int, top_p: float, greedy: bool):
    import numpy as np
    if greedy or temperature <= 0:
        return np.argmax(logits, axis=-1, keepdims=True).astype(np.int64)

    scores = logits.astype(np.float64) / temperature
    if 0 < top_k < scores.shape[-1]:
        cutoff = np.partition(scores, -top_k, axis=-1)[:, -top_k][:, None]
        scores = np.where(scores < cutoff, -np.inf, scores)

    order = np.argsort(scores, axis=-1)[:, ::-1]
    ordered = np.take_along_axis(scores, order, axis=-1)
    ordered -= np.max(ordered, axis=-1, keepdims=True)
    probs = np.exp(ordered)
    probs /= probs.sum(axis=-1, keepdims=True)

    if 0 < top_p < 1:
        cumulative = np.cumsum(probs, axis=-1)
        remove = cumulative - probs >= top_p
        probs = np.where(remove, 0.0, probs)
        probs /= probs.sum(axis=-1, keepdims=True)

    sampled = [rng.choice(order.shape[1], p=probs[row]) for row in range(order.shape[0])]
    return np.take_along_axis(order, np.asarray(sampled)[:, None], axis=-1).astype(np.int64)


def _tts_voices_for_engine(engine: str) -> list[str]:
    if engine == "kokoro":
        return list(KOKORO_VOICES)
    return sorted(_tts_list_voices().keys())


def _tts_reference_voice(voice_name: str | None, configured_path: str) -> str:
    if voice_name:
        voices = _tts_list_voices()
        match = voices.get(voice_name.strip().lower())
        if match:
            return match
        raise ValueError(f"reference voice {voice_name!r} was not found in {TTS_VOICES_DIR}")
    return configured_path


def _tts_decode_wav(data: bytes):
    import numpy as np
    from scipy.io import wavfile

    sample_rate, audio = wavfile.read(io.BytesIO(data))
    if sample_rate <= 0:
        raise ValueError(f"TTS service returned an invalid sample rate: {sample_rate}")
    values = np.asarray(audio)
    if values.ndim == 2:
        values = values.mean(axis=1)
    elif values.ndim != 1:
        raise ValueError(f"unsupported WAV audio dimensions: {values.shape}")
    if np.issubdtype(values.dtype, np.integer):
        limits = np.iinfo(values.dtype)
        scale = max(abs(limits.min), abs(limits.max))
        values = values.astype(np.float32) / scale
    elif np.issubdtype(values.dtype, np.floating):
        values = values.astype(np.float32)
    else:
        raise ValueError(f"unsupported WAV sample type: {values.dtype}")
    if not len(values):
        raise ValueError("TTS service returned an empty WAV")
    return values, int(sample_rate)


def _tts_fish_generate(
    text: str,
    voice_name: str | None = None,
    reference_text: str | None = None,
):
    endpoint = urllib.parse.urlsplit(TTS_FISH_ENDPOINT)
    if endpoint.scheme not in ("http", "https") or not endpoint.hostname:
        raise ValueError(f"invalid Fish S2 endpoint: {TTS_FISH_ENDPOINT!r}")

    boundary = "----streamd-fish-" + os.urandom(12).hex()
    chunks: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        chunks.extend((
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode("utf-8"),
            b"\r\n",
        ))

    add_field("text", text)
    reference_audio = _tts_reference_voice(voice_name, TTS_FISH_REFERENCE_AUDIO)
    reference_path = Path(reference_audio) if reference_audio else None
    transcript = (reference_text or "").strip()
    if not voice_name and not transcript:
        transcript = TTS_FISH_REFERENCE_TEXT.strip()
    if reference_path is not None:
        if not reference_path.is_file():
            raise FileNotFoundError(f"Fish S2 reference audio not found: {reference_path}")
        if not transcript:
            raise ValueError("enter the transcript for the selected Fish reference audio")
        chunks.extend((
            f"--{boundary}\r\n".encode(),
            (
                'Content-Disposition: form-data; name="reference"; '
                f'filename="{reference_path.name}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode(),
            reference_path.read_bytes(),
            b"\r\n",
        ))
        add_field("reference_text", transcript)
    elif transcript:
        raise ValueError("TTS_FISH_REFERENCE_AUDIO is required when reference text is set")
    add_field("params", json.dumps({
        "temperature": 0.9,
        "top_p": 0.9,
        "max_new_tokens": TTS_MAX_NEW_TOKENS,
    }))
    chunks.append(f"--{boundary}--\r\n".encode())
    request = urllib.request.Request(
        TTS_FISH_ENDPOINT,
        data=b"".join(chunks),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TTS_FISH_TIMEOUT) as response:
            content_type = response.headers.get_content_type()
            body = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"Fish S2 server returned HTTP {exc.code}"
            + (f": {detail}" if detail else "")
        ) from exc
    if content_type != "audio/wav":
        detail = body[:500].decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Fish S2 returned unexpected content type {content_type!r}: {detail}"
        )
    return _tts_decode_wav(body)


class _F5Worker:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None
        self.responses: queue.Queue[str | None] = queue.Queue()
        self.lock = threading.Lock()

    def _read_stdout(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            self.responses.put(line)
        self.responses.put(None)

    @staticmethod
    def _read_stderr(process: subprocess.Popen[str]) -> None:
        assert process.stderr is not None
        for line in process.stderr:
            log.info("[tts:f5] %s", line.rstrip())

    def _receive(self, timeout: float) -> dict:
        try:
            line = self.responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError("timed out waiting for the F5-TTS worker") from exc
        if line is None:
            code = self.process.poll() if self.process is not None else None
            raise RuntimeError(f"F5-TTS worker exited unexpectedly (code {code})")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"F5-TTS worker returned invalid protocol data: {line[:300]!r}") from exc
        if not response.get("ok"):
            raise RuntimeError(f"F5-TTS worker error: {response.get('error', 'unknown error')}")
        return response

    def start(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        if not TTS_F5_PYTHON.strip():
            raise RuntimeError(
                "F5-TTS requires TTS_F5_PYTHON to point to its separate environment's Python executable"
            )
        worker_script = Path(__file__).with_name("tts_f5_worker.py")
        if not worker_script.is_file():
            raise FileNotFoundError(f"F5-TTS worker script not found: {worker_script}")

        command = [
            TTS_F5_PYTHON, str(worker_script),
            "--model", TTS_F5_MODEL,
        ]
        if TTS_F5_DEVICE.strip():
            command.extend(("--device", TTS_F5_DEVICE.strip()))
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.process = process
        self.responses = queue.Queue()
        threading.Thread(
            target=self._read_stdout, args=(process,), daemon=True, name="tts-f5-stdout",
        ).start()
        threading.Thread(
            target=self._read_stderr, args=(process,), daemon=True, name="tts-f5-stderr",
        ).start()
        try:
            self._receive(TTS_F5_STARTUP_TIMEOUT)
        except Exception:
            self.stop()
            raise
        log.info("[tts] F5-TTS worker ready using model %s", TTS_F5_MODEL)

    def generate(self, text: str, reference_audio: str, reference_text: str):
        import numpy as np

        with self.lock:
            self.start()
            assert self.process is not None and self.process.stdin is not None
            self.process.stdin.write(json.dumps({
                "op": "generate",
                "text": text,
                "reference_audio": reference_audio,
                "reference_text": reference_text,
            }) + "\n")
            self.process.stdin.flush()
            try:
                response = self._receive(TTS_F5_TIMEOUT)
            except TimeoutError:
                self.stop()
                raise
        try:
            audio = base64.b64decode(response["audio"], validate=True)
            sample_rate = int(response["sample_rate"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("F5-TTS worker returned malformed audio data") from exc
        samples = np.frombuffer(audio, dtype="<f4").copy()
        if not samples.size or sample_rate <= 0:
            raise RuntimeError("F5-TTS worker returned empty audio or an invalid sample rate")
        return samples, sample_rate

    def stop(self) -> None:
        process = self.process
        if process is None:
            return
        if process.poll() is None:
            try:
                if process.stdin is not None:
                    process.stdin.write('{"op":"shutdown"}\n')
                    process.stdin.flush()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        self.process = None


def _tts_stop_f5_worker() -> None:
    worker = state.tts_f5_worker
    if worker is not None:
        worker.stop()


atexit.register(_tts_stop_f5_worker)


def _tts_load_model(engine: str | None = None) -> None:
    tstate = state.tts_state()
    previous_engine = tstate.get("engine")
    selected_engine = (engine or tstate.get("engine") or TTS_ENGINE_DEFAULT).strip().lower()
    tstate["engine"] = selected_engine
    tstate["pending_engine"] = None
    tstate["engine_name"] = TTS_ENGINE_NAMES.get(selected_engine, selected_engine)
    tstate["engines"] = [
        {"id": engine_id, "name": name} for engine_id, name in TTS_ENGINE_NAMES.items()
    ]
    tstate["voices"] = _tts_voices_for_engine(selected_engine)
    tstate["reference_texts"] = _tts_load_reference_texts()
    tstate["reference_text_saved"] = ""
    tstate["loading"] = True
    tstate["ready"] = False
    tstate["error"] = ""
    state.tts_sessions = None
    state.tts_tokenizer = None
    state.tts_kokoro = None

    try:
        if previous_engine == "f5_tts" and selected_engine != "f5_tts":
            _tts_stop_f5_worker()
        try:
            _tts_list_output_devices()
        except Exception as exc:
            tstate["output_devices"] = []
            tstate["output_error"] = str(exc)
            log.warning("[tts] could not enumerate output devices: %s", exc)

        if selected_engine not in TTS_ENGINE_NAMES:
            raise ValueError(f"unsupported TTS engine: {selected_engine}")
        if not TTS_ENABLED_DEFAULT and not tstate.get("enabled"):
            log.info("[tts] TTS is disabled; skipping model load")
        elif selected_engine == "chatterbox":
            from pathlib import Path
            from tokenizers import Tokenizer

            log.info(
                "[tts] loading chatterbox nano (onnx, %s) from %s ...",
                TTS_ONNX_DTYPE, TTS_ONNX_MODEL_DIR,
            )
            component_paths = {
                name: _tts_graph_path(TTS_ONNX_MODEL_DIR, name, TTS_ONNX_DTYPE)
                for name in ("embed_tokens", "speech_encoder", "language_model", "conditional_decoder")
            }
            state.tts_sessions = {
                name: _tts_make_session(path, TTS_ONNX_PROVIDER)
                for name, path in component_paths.items()
            }
            tokenizer_path = Path(TTS_ONNX_MODEL_DIR) / "tokenizer.json"
            state.tts_tokenizer = Tokenizer.from_file(str(tokenizer_path))
            tstate["ready"] = True
            log.info("[tts] chatterbox nano ready")
        elif selected_engine == "kokoro":
            from pathlib import Path
            try:
                kokoro_module = import_module("kokoro_onnx")
            except ModuleNotFoundError as exc:
                raise RuntimeError(
                    "Kokoro requires the optional `kokoro-onnx` package"
                ) from exc

            model_path = Path(TTS_KOKORO_MODEL_PATH)
            voices_path = Path(TTS_KOKORO_VOICES_PATH)
            if not model_path.is_file():
                raise FileNotFoundError(f"Kokoro model not found: {model_path}")
            if not voices_path.is_file():
                raise FileNotFoundError(f"Kokoro voices file not found: {voices_path}")
            log.info("[tts] loading Kokoro ONNX model from %s ...", model_path)
            state.tts_kokoro = kokoro_module.Kokoro(str(model_path), str(voices_path))
            tstate["ready"] = True
            log.info("[tts] Kokoro ready")
        elif selected_engine == "fish_s2_gguf":
            endpoint = urllib.parse.urlsplit(TTS_FISH_ENDPOINT)
            if endpoint.scheme not in ("http", "https") or not endpoint.hostname:
                raise ValueError(f"invalid Fish S2 endpoint: {TTS_FISH_ENDPOINT!r}")
            port = endpoint.port or (443 if endpoint.scheme == "https" else 80)
            try:
                with socket.create_connection((endpoint.hostname, port), timeout=3):
                    pass
            except OSError as exc:
                raise RuntimeError(
                    f"Fish S2 server is not reachable at {endpoint.hostname}:{port}; "
                    "start the s2.cpp server and check TTS_FISH_ENDPOINT"
                ) from exc
            tstate["ready"] = True
            log.info("[tts] Fish S2 server reachable at %s", TTS_FISH_ENDPOINT)
        elif selected_engine == "f5_tts":
            if state.tts_f5_worker is None:
                state.tts_f5_worker = _F5Worker()
            state.tts_f5_worker.start()
            tstate["ready"] = True
            log.info("[tts] F5-TTS ready")
    except Exception as exc:
        tstate["error"] = str(exc)
        log.error("[tts] failed to load %s:\n%s", selected_engine, traceback.format_exc())
    finally:
        tstate["loading"] = False
        _tts_broadcast()


def _tts_list_voices() -> dict[str, str]:
    voices: dict[str, str] = {}
    if TTS_VOICES_DIR.exists():
        for p in sorted(TTS_VOICES_DIR.iterdir()):
            if p.is_file() and p.suffix.lower() in TTS_VOICE_EXTS:
                voices[p.stem.lower()] = str(p)
    return voices


def _tts_load_reference_texts() -> dict[str, str]:
    transcripts: dict[str, str] = {}
    for voice_name, audio_path in _tts_list_voices().items():
        text_path = Path(audio_path).with_suffix(".txt")
        if text_path.is_file():
            transcripts[voice_name] = text_path.read_text(encoding="utf-8")
    return transcripts


def tts_save_reference_text(voice_name: object, text: object) -> str:
    voice = str(voice_name or "").strip().lower()
    if not voice:
        raise ValueError("select a reference voice before saving its transcript")
    voices = _tts_list_voices()
    audio_path = voices.get(voice)
    if audio_path is None:
        raise ValueError(f"reference voice {voice!r} was not found in {TTS_VOICES_DIR}")
    transcript = str(text or "")
    text_path = Path(audio_path).with_suffix(".txt")
    temporary_path = text_path.with_name(text_path.name + ".tmp")
    with TTS_REFERENCE_TEXT_LOCK:
        try:
            temporary_path.write_text(transcript, encoding="utf-8")
            os.replace(temporary_path, text_path)
        except OSError:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                log.exception("[tts] failed cleaning temporary transcript file %s", temporary_path)
            raise
    tstate = state.tts_state()
    reference_texts = tstate.setdefault("reference_texts", {})
    reference_texts[voice] = transcript
    tstate["reference_text_saved"] = voice
    tstate["reference_text_error"] = ""
    _tts_broadcast()
    return str(text_path)


def _tts_resolve_voice(voice_name: str | None) -> str:
    if voice_name:
        voices = _tts_list_voices()
        match = voices.get(voice_name.strip().lower())
        if match:
            return match
        log.warning("[tts] voice %r not found in %s, using default voice", voice_name, TTS_VOICES_DIR)
    return TTS_VOICE_PATH


def _tts_generate(
    text: str,
    voice_name: str | None = None,
    on_progress=None,
    reference_text: str | None = None,
):
    """Generate one utterance with the active TTS engine."""
    engine = state.tts_state().get("engine", "chatterbox")
    if engine == "kokoro":
        if state.tts_kokoro is None:
            raise RuntimeError("Kokoro model is not ready")
        return state.tts_kokoro.create(
            text,
            voice=voice_name or TTS_KOKORO_VOICE,
            speed=1.0,
            lang=TTS_KOKORO_LANGUAGE,
        )
    if engine == "fish_s2_gguf":
        return _tts_fish_generate(text, voice_name, reference_text)
    if engine == "f5_tts":
        if state.tts_f5_worker is None:
            raise RuntimeError("F5-TTS worker is not ready")
        reference_audio = _tts_reference_voice(voice_name, TTS_F5_REFERENCE_AUDIO)
        transcript = (reference_text or "").strip()
        if not voice_name and not transcript:
            transcript = TTS_F5_REFERENCE_TEXT.strip()
        if not reference_audio:
            raise ValueError("select an F5-TTS reference audio file")
        if not transcript:
            raise ValueError("enter the transcript for the selected F5-TTS reference audio")
        return state.tts_f5_worker.generate(text, reference_audio, transcript)

    import numpy as np
    import librosa

    if state.tts_sessions is None or state.tts_tokenizer is None:
        raise RuntimeError("TTS model is not ready")

    def _as_array(value: object) -> np.ndarray:
        return np.asarray(value)

    rng = np.random.default_rng()

    audio, _ = librosa.load(
        _tts_resolve_voice(voice_name), sr=SAMPLE_RATE_TTS, mono=True
    )
    audio_values = audio[None, :].astype(np.float32)
    encoder_outputs = state.tts_sessions["speech_encoder"].run(None, {"audio_values": audio_values})
    audio_features, audio_tokens, speaker_embeddings, speaker_features = (
        _as_array(value) for value in encoder_outputs
    )

    encoded = state.tts_tokenizer.encode(text)
    input_ids = np.array([encoded.ids], dtype=np.int64)
    generated = np.full((input_ids.shape[0], 1), START_SPEECH_TOKEN, dtype=np.int64)

    lm = state.tts_sessions["language_model"]
    cache: dict[str, np.ndarray] | None = None
    attention_mask: np.ndarray | None = None
    position_ids: np.ndarray | None = None
    reached_eos = False

    for step in range(TTS_MAX_NEW_TOKENS):
        embeds = state.tts_sessions["embed_tokens"].run(None, {"input_ids": input_ids})[0]
        if step == 0:
            embeds = np.concatenate((audio_features, embeds), axis=1)
            batch_size, sequence_length, _ = embeds.shape
            cache = _tts_empty_cache(lm, batch_size)
            attention_mask = np.ones((batch_size, sequence_length), dtype=np.int64)
            position_ids = np.arange(sequence_length, dtype=np.int64)[None, :].repeat(batch_size, axis=0)

        assert cache is not None
        assert attention_mask is not None
        assert position_ids is not None
        outputs = lm.run(
            None,
            {
                "inputs_embeds": embeds,
                "attention_mask": attention_mask,
                "position_ids": position_ids,
                **cache,
            },
        )
        logits = _tts_repetition_penalty(
            _as_array(outputs[0])[:, -1, :], generated, TTS_REPETITION_PENALTY
        )
        input_ids = _tts_sample_token(logits, rng, TTS_TEMPERATURE, TTS_TOP_K, TTS_TOP_P, TTS_GREEDY)
        generated = np.concatenate((generated, input_ids), axis=-1)
        if on_progress is not None:
            on_progress(step + 1, TTS_MAX_NEW_TOKENS)

        if np.all(input_ids == STOP_SPEECH_TOKEN):
            reached_eos = True
            break

        attention_mask = np.concatenate((attention_mask, np.ones((attention_mask.shape[0], 1), dtype=np.int64)), axis=1)
        position_ids = position_ids[:, -1:] + 1
        for index, name in enumerate(cache):
            cache[name] = _as_array(outputs[index + 1])

    generated_audio = generated[:, 1:-1] if reached_eos else generated[:, 1:]
    silence = np.full((generated_audio.shape[0], 3), SILENCE_TOKEN, dtype=np.int64)
    speech_tokens = np.concatenate((audio_tokens, generated_audio, silence), axis=1)
    waveform = state.tts_sessions["conditional_decoder"].run(
        None,
        {
            "speech_tokens": speech_tokens,
            "speaker_embeddings": speaker_embeddings,
            "speaker_features": speaker_features,
        },
    )[0]
    return _as_array(waveform).squeeze(), SAMPLE_RATE_TTS


def _tts_play_audio(audio, sr) -> bool:
    import numpy as np
    import sounddevice as sd
    import scipy.signal

    audio = np.asarray(audio, dtype=np.float32)
    if audio.size == 0:
        return False

    device = state.tts_state().get("output_device")

    device_info = sd.query_devices(device, 'output')
    target_sr = int(device_info['default_samplerate'])

    if sr != target_sr:
        num_samples = int(round(len(audio) * float(target_sr) / sr))
        audio = np.asarray(scipy.signal.resample(audio, num_samples), dtype=np.float32)
        sr = target_sr

    sd.play(audio, sr, device=device)
    sd.wait()
    return True


def run_tts_worker() -> None:
    state.tts_queue = queue.Queue()

    _tts_load_model()

    while True:
        item = state.tts_queue.get()
        if not item:
            continue
        text, voice_name, reference_text = item
        if text is None:
            _tts_load_model(voice_name)
            continue
        if not text:
            continue
        tstate = state.tts_state()
        engine = tstate.get("engine", "chatterbox")
        if (
            not tstate.get("enabled")
            or not tstate.get("ready")
            or (engine == "chatterbox" and state.tts_sessions is None)
            or (engine == "kokoro" and state.tts_kokoro is None)
        ):
            tstate["queue_len"] = _tts_queue_length()
            _tts_broadcast()
            continue

        with state.tts_lock:
            tstate["generating"] = True
            tstate["error"] = ""
            tstate["current"] = text
            tstate["voice"] = voice_name or (
                TTS_KOKORO_VOICE if tstate.get("engine") == "kokoro" else "default"
            )
            tstate["generation_step"] = 0
            tstate["generation_max_steps"] = (
                TTS_MAX_NEW_TOKENS if tstate.get("engine") == "chatterbox" else 0
            )
            tstate["generation_elapsed"] = 0.0
            tstate["generation_tokens_per_second"] = 0.0
            tstate["queue_len"] = _tts_queue_length()
            _tts_broadcast()

            audio = None
            sr = None
            generation_started = time.monotonic()
            last_progress_broadcast = generation_started
            generation_stop = threading.Event()

            def report_progress(step: int, maximum: int) -> None:
                nonlocal last_progress_broadcast
                now = time.monotonic()
                elapsed = now - generation_started
                tstate["generation_step"] = step
                tstate["generation_max_steps"] = maximum
                tstate["generation_elapsed"] = elapsed
                tstate["generation_tokens_per_second"] = step / elapsed if elapsed else 0.0
                if now - last_progress_broadcast >= 0.25 or step >= maximum:
                    _tts_broadcast()
                    last_progress_broadcast = now

            def report_kokoro_elapsed() -> None:
                while not generation_stop.wait(0.5):
                    tstate["generation_elapsed"] = time.monotonic() - generation_started
                    _tts_broadcast()

            elapsed_reporter = None
            if engine in ("kokoro", "fish_s2_gguf", "f5_tts"):
                elapsed_reporter = threading.Thread(
                    target=report_kokoro_elapsed,
                    daemon=True,
                    name="tts-generation-status",
                )
                elapsed_reporter.start()
            try:
                audio, sr = _tts_generate(
                    text, voice_name, report_progress, reference_text
                )
            except Exception as exc:
                tstate["error"] = str(exc)
                log.error("[tts] generate failed:\n%s", traceback.format_exc())
            finally:
                generation_stop.set()
                if elapsed_reporter is not None:
                    elapsed_reporter.join()

            tstate["generating"] = False
            tstate["generation_elapsed"] = time.monotonic() - generation_started
            _tts_broadcast()

            if audio is not None:
                tstate["speaking"] = True
                tstate["output_error"] = ""
                _tts_broadcast()
                broadcast_sync({"type": "tts_say", "text": text, "voice": voice_name or "default"})

                try:
                    _tts_play_audio(audio, sr)
                except Exception as exc:
                    tstate["output_error"] = str(exc)
                    log.error("[tts] playback failed:\n%s", traceback.format_exc())

                tstate["speaking"] = False

        tstate["current"] = ""
        tstate["queue_len"] = _tts_queue_length()
        _tts_broadcast()


def tts_say(
    text,
    voice: str | None = None,
    reference_text: str | None = None,
) -> None:
    text = (text or "").strip()
    if not text or state.tts_queue is None:
        return
    state.tts_queue.put((text, voice, reference_text))
    state.tts_state()["queue_len"] = _tts_queue_length()
    _tts_broadcast()


def tts_set_engine(engine: str) -> None:
    engine = str(engine or "").strip().lower()
    if engine not in TTS_ENGINE_NAMES:
        raise ValueError(f"unsupported TTS engine: {engine}")
    tstate = state.tts_state()
    if engine == (tstate.get("pending_engine") or tstate.get("engine")):
        return
    tstate["pending_engine"] = engine
    if state.tts_queue is None:
        _tts_load_model(engine)
        return
    state.tts_queue.put((None, engine, None))
    _tts_broadcast()


def tts_set_output_device(device_id: object) -> None:
    tstate = state.tts_state()
    try:
        devices = _tts_list_output_devices()
        if not devices:
            raise ValueError(tstate.get("output_error") or "No audio output devices are available")
        if device_id in ("", None, "default", "None"):
            selected = None
        else:
            if isinstance(device_id, bool) or not isinstance(device_id, (str, int)):
                raise ValueError(f"invalid audio output device: {device_id!r}")
            selected = int(device_id)
            if selected not in {device["id"] for device in devices}:
                raise ValueError(f"audio output device {selected} is unavailable")
        tstate["output_device"] = selected
        tstate["output_device_name"] = next(
            (device["name"] for device in devices if device["id"] == selected),
            "System default",
        )
        tstate["output_error"] = ""
    except Exception as exc:
        tstate["output_error"] = str(exc)
        log.warning("[tts] could not select output device %r: %s", device_id, exc)
    tstate["output_device_override"] = True
    _tts_broadcast()


def tts_skip() -> None:
    try:
        import sounddevice as sd
        sd.stop()
    except Exception:
        pass


def tts_clear_queue() -> None:
    if state.tts_queue is None:
        return
    retained = []
    while True:
        try:
            item = state.tts_queue.get_nowait()
        except queue.Empty:
            break
        if item[0] is None:
            retained.append(item)
    for item in retained:
        state.tts_queue.put(item)
    state.tts_state()["queue_len"] = _tts_queue_length()
    _tts_broadcast()


def tts_set_enabled(enabled: bool) -> None:
    state.tts_state()["enabled"] = enabled
    if enabled and not state.tts_state().get("ready") and state.tts_queue is not None:
        state.tts_queue.put((
            None, state.tts_state().get("engine", TTS_ENGINE_DEFAULT), None
        ))
    _tts_broadcast()


def _focus_tts_entry(root, entry) -> bool:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
    user32.GetAncestor.restype = wintypes.HWND
    user32.GetForegroundWindow.argtypes = ()
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = (
        wintypes.HWND, ctypes.POINTER(wintypes.DWORD),
    )
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = (
        wintypes.DWORD, wintypes.DWORD, wintypes.BOOL,
    )
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
    user32.ShowWindow.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = (wintypes.HWND,)
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.SetFocus.argtypes = (wintypes.HWND,)
    user32.SetFocus.restype = wintypes.HWND
    user32.GetFocus.argtypes = ()
    user32.GetFocus.restype = wintypes.HWND
    kernel32.GetCurrentThreadId.argtypes = ()
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    hwnd_entry = entry if isinstance(entry, int) else entry.winfo_id()
    if isinstance(root, int):
        hwnd_root = root
    else:
        hwnd_root = user32.GetAncestor(hwnd_entry, 2) or root.winfo_id()
    foreground = user32.GetForegroundWindow()
    foreground_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    current_thread = kernel32.GetCurrentThreadId()
    attached = bool(foreground_thread and foreground_thread != current_thread)

    if attached and not user32.AttachThreadInput(foreground_thread, current_thread, True):
        log.warning(
            "[hotkeys] could not attach popup input to foreground thread (winerror=%d)",
            ctypes.get_last_error(),
        )
        attached = False

    try:
        user32.ShowWindow(hwnd_root, 9)
        user32.BringWindowToTop(hwnd_root)
        foreground_set = bool(user32.SetForegroundWindow(hwnd_root))
        user32.SetFocus(hwnd_entry)
        return (
            foreground_set
            and user32.GetForegroundWindow() == hwnd_root
            and user32.GetFocus() == hwnd_entry
        )
    finally:
        if attached:
            user32.AttachThreadInput(foreground_thread, current_thread, False)


def _run_windows_tts_popup() -> None:
    import ctypes
    from ctypes import wintypes

    class Point(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    class Message(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("message", wintypes.UINT),
            ("wParam", wintypes.WPARAM),
            ("lParam", wintypes.LPARAM),
            ("time", wintypes.DWORD),
            ("pt", Point),
            ("lPrivate", wintypes.DWORD),
        ]

    window_proc_type = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
        wintypes.WPARAM, wintypes.LPARAM,
    )

    class WindowClass(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", window_proc_type),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.RegisterClassW.argtypes = (ctypes.POINTER(WindowClass),)
    user32.RegisterClassW.restype = wintypes.ATOM
    user32.CreateWindowExW.argtypes = (
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, ctypes.c_void_p,
    )
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DefWindowProcW.argtypes = (
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    )
    user32.DefWindowProcW.restype = ctypes.c_ssize_t
    user32.DestroyWindow.argtypes = (wintypes.HWND,)
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = (
        ctypes.POINTER(Message), wintypes.HWND, wintypes.UINT, wintypes.UINT,
    )
    user32.GetMessageW.restype = wintypes.BOOL
    user32.TranslateMessage.argtypes = (ctypes.POINTER(Message),)
    user32.DispatchMessageW.argtypes = (ctypes.POINTER(Message),)
    user32.SetTimer.argtypes = (
        wintypes.HWND, ctypes.c_size_t, wintypes.UINT, ctypes.c_void_p,
    )
    user32.SetTimer.restype = ctypes.c_size_t
    user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.SetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPCWSTR)
    user32.SetWindowTextW.restype = wintypes.BOOL
    user32.SetWindowLongPtrW.argtypes = (
        wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t,
    )
    user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
    user32.CallWindowProcW.argtypes = (
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
        wintypes.WPARAM, wintypes.LPARAM,
    )
    user32.CallWindowProcW.restype = ctypes.c_ssize_t
    user32.GetSystemMetrics.argtypes = (ctypes.c_int,)
    user32.GetSystemMetrics.restype = ctypes.c_int
    kernel32.GetModuleHandleW.argtypes = (wintypes.LPCWSTR,)
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    kernel32.GetCurrentThreadId.argtypes = ()
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    hwnds: dict[str, int] = {}
    class_name = f"StreamdTTSInput-{kernel32.GetCurrentThreadId()}"
    instance = kernel32.GetModuleHandleW(None)
    width, height = 620, 116

    def get_entry_text() -> str:
        hwnd = hwnds.get("entry")
        if not hwnd:
            return ""
        length = user32.GetWindowTextLengthW(hwnd)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, len(buffer))
        return buffer.value

    def update_preview() -> None:
        text = get_entry_text()
        preview = text or "Type to speak · Enter sends · Esc closes"
        user32.SetWindowTextW(hwnds["preview"], preview)

    def update_info() -> None:
        tstate = state.tts_state()
        typed = get_entry_text()
        activity = "ready"
        if tstate.get("generating"):
            maximum = int(tstate.get("generation_max_steps") or 0)
            step = int(tstate.get("generation_step") or 0)
            progress = f" · {step}/{maximum} tokens" if maximum else ""
            speed = float(tstate.get("generation_tokens_per_second") or 0)
            activity = (
                f"generating {tstate.get('engine_name', '')}"
                f" · {float(tstate.get('generation_elapsed') or 0):.1f}s"
                f"{progress} · {speed:.1f} tok/s"
            )
        elif tstate.get("speaking"):
            activity = "speaking"
        elif tstate.get("loading"):
            activity = "loading model"
        elif tstate.get("output_error") or tstate.get("error"):
            activity = tstate.get("output_error") or tstate.get("error")
        elif not tstate.get("ready"):
            activity = "model unavailable"
        text = (
            f"{len(typed)} chars · {len(typed.split())} words"
            f" · queue {tstate.get('queue_len', 0)} · {activity}"
            f" · output {tstate.get('output_device_name', 'System default')}"
        )
        user32.SetWindowTextW(hwnds["info"], text)

    def wnd_proc(hwnd, message, wparam, lparam):
        if message == 0x0001:  # WM_CREATE
            hwnds["info"] = user32.CreateWindowExW(
                0, "STATIC", "", 0x50000000, 14, 8, width - 28, 20,
                hwnd, None, instance, None,
            )
            hwnds["preview"] = user32.CreateWindowExW(
                0, "STATIC", "", 0x50000000, 14, 30, width - 28, 27,
                hwnd, None, instance, None,
            )
            hwnds["entry"] = user32.CreateWindowExW(
                0x00000004, "EDIT", "", 0x50010080,
                14, 62, width - 28, 38, hwnd, None, instance, None,
            )
            user32.SetTimer(hwnd, 1, 200, None)
            return 0
        if message == 0x0005:  # WM_SIZE
            if hwnds.get("info"):
                update_preview()
                update_info()
            return 0
        if message == 0x0111 and lparam == hwnds.get("entry"):  # WM_COMMAND
            notification = (wparam >> 16) & 0xFFFF
            if notification == 0x0400:  # EN_UPDATE
                update_preview()
                update_info()
            return 0
        if message == 0x0113:  # WM_TIMER
            update_info()
            return 0
        if message == 0x0010:  # WM_CLOSE
            user32.DestroyWindow(hwnd)
            return 0
        if message == 0x0002:  # WM_DESTROY
            ctypes.WinDLL("user32").PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def entry_proc(hwnd, message, wparam, lparam):
        if message == 0x0100 and wparam == 0x0D:  # WM_KEYDOWN / VK_RETURN
            text = get_entry_text().strip()
            if text:
                tts_say(text)
            user32.DestroyWindow(hwnds["root"])
            return 0
        if message == 0x0100 and wparam == 0x1B:  # WM_KEYDOWN / VK_ESCAPE
            user32.DestroyWindow(hwnds["root"])
            return 0
        return user32.CallWindowProcW(
            hwnds["old_entry_proc"], hwnd, message, wparam, lparam,
        )

    wnd_proc_callback = window_proc_type(wnd_proc)
    entry_proc_callback = window_proc_type(entry_proc)
    window_class = WindowClass(
        0, wnd_proc_callback, 0, 0, instance, None, None,
        ctypes.c_void_p(6), None, class_name,
    )
    if not user32.RegisterClassW(ctypes.byref(window_class)):
        raise ctypes.WinError(ctypes.get_last_error())

    screen_width = user32.GetSystemMetrics(0)
    screen_height = user32.GetSystemMetrics(1)
    root_hwnd = user32.CreateWindowExW(
        0x00000080 | 0x00000008,
        class_name,
        "streamd TTS",
        0x80000000,
        (screen_width - width) // 2,
        int(screen_height * 0.72),
        width,
        height,
        None,
        None,
        instance,
        None,
    )
    if not root_hwnd:
        raise ctypes.WinError(ctypes.get_last_error())
    hwnds["root"] = root_hwnd
    hwnds["old_entry_proc"] = user32.SetWindowLongPtrW(
        hwnds["entry"], -4, ctypes.cast(entry_proc_callback, ctypes.c_void_p).value,
    )
    update_preview()
    update_info()

    focused = _focus_tts_entry(root_hwnd, hwnds["entry"])
    log.info(
        "[hotkeys] native TTS popup opened (foreground+entry focus=%s)",
        focused,
    )

    message = Message()
    while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(message))
        user32.DispatchMessageW(ctypes.byref(message))


def _open_tts_input_popup() -> None:
    """small always-on-top borderless input box, for typing tts lines over
    a borderless windowed game. enter sends + closes, escape cancels."""
    if not state.tts_popup_open.acquire(blocking=False):
        return

    def _run() -> None:
        try:
            if os.name != "nt":
                raise OSError("the native TTS input popup is currently Windows-only")
            _run_windows_tts_popup()
        except Exception as e:
            log.warning("[hotkeys] tts popup failed: %s", e)
        finally:
            state.tts_popup_open.release()

    threading.Thread(target=_run, daemon=True).start()


def run_hotkeys() -> None:
    try:
        import keyboard
    except ImportError:
        log.warning("[hotkeys] `keyboard` not installed, skipping global hotkeys")
        return

    try:
        keyboard.add_hotkey("ctrl+alt+space", _open_tts_input_popup)
        keyboard.add_hotkey("ctrl+alt+s", tts_skip)
        keyboard.add_hotkey("ctrl+alt+c", tts_clear_queue)
        keyboard.add_hotkey("ctrl+alt+t", _open_tts_input_popup)
        log.info("[hotkeys] registered: ctrl+alt+space/ctrl+alt+t=tts input box, "
                 "ctrl+alt+s=skip, ctrl+alt+c=clear queue")
        keyboard.wait()
    except Exception as e:
        log.warning("[hotkeys] failed to register: %s", e)
