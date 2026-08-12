import queue
import threading
import time
import traceback
from typing import Any

from config import (
    log, TTS_ENABLED_DEFAULT, TTS_VOICE_PATH, TTS_ONNX_MODEL_DIR, TTS_ONNX_DTYPE,
    TTS_ONNX_PROVIDER, TTS_MAX_NEW_TOKENS, TTS_TEMPERATURE, TTS_TOP_K, TTS_TOP_P,
    TTS_REPETITION_PENALTY, TTS_GREEDY, TTS_VOICES_DIR, TTS_VOICE_EXTS, TTS_OUTPUT_DEVICE,
    onnxruntime_preloaded,
)
from state import state
from broadcast import broadcast_sync

SAMPLE_RATE_TTS = 24_000
START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299


def _tts_broadcast() -> None:
    broadcast_sync({"type": "tts_state", "tts": state.tts_state()})


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


def _tts_load_model() -> None:
    state.tts_state()["voices"] = sorted(_tts_list_voices().keys())
    if TTS_ENABLED_DEFAULT is True:
        try:
            from tokenizers import Tokenizer
            from pathlib import Path

            log.info("[tts] loading chatterbox nano (onnx, %s) from %s ...", TTS_ONNX_DTYPE, TTS_ONNX_MODEL_DIR)
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

            state.tts_state()["ready"] = True
            state.tts_state()["loading"] = False
            log.info("[tts] model ready")
        except Exception:
            log.error("[tts] failed to load model:\n%s", traceback.format_exc())
            state.tts_state()["loading"] = False
            state.tts_state()["ready"] = False
        _tts_broadcast()
    else:
        state.tts_state()["loading"] = False
        state.tts_state()["ready"] = False
        _tts_broadcast()
        print("[tts] TTS_ENABLED is false, skipping model load")


def _tts_list_voices() -> dict[str, str]:
    voices: dict[str, str] = {}
    if TTS_VOICES_DIR.exists():
        for p in sorted(TTS_VOICES_DIR.iterdir()):
            if p.is_file() and p.suffix.lower() in TTS_VOICE_EXTS:
                voices[p.stem.lower()] = str(p)
    return voices


def _tts_resolve_voice(voice_name: str | None) -> str:
    if voice_name:
        voices = _tts_list_voices()
        match = voices.get(voice_name.strip().lower())
        if match:
            return match
        log.warning("[tts] voice %r not found in %s, using default voice", voice_name, TTS_VOICES_DIR)
    return TTS_VOICE_PATH


def _tts_generate(text: str, voice_path: str | None = None):
    """runs the 4-graph nano pipeline, returns (waveform, sample_rate)."""
    import numpy as np
    import librosa

    if state.tts_sessions is None or state.tts_tokenizer is None:
        raise RuntimeError("TTS model is not ready")

    def _as_array(value: object) -> np.ndarray:
        return np.asarray(value)

    rng = np.random.default_rng()

    audio, _ = librosa.load(voice_path or TTS_VOICE_PATH, sr=SAMPLE_RATE_TTS, mono=True)
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

    device = TTS_OUTPUT_DEVICE or None

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
        text, voice_name = item
        if not text:
            continue
        tstate = state.tts_state()
        if not tstate.get("enabled") or not tstate.get("ready") or state.tts_sessions is None:
            tstate["queue_len"] = state.tts_queue.qsize()
            _tts_broadcast()
            continue

        voice_path = _tts_resolve_voice(voice_name)

        with state.tts_lock:
            tstate["generating"] = True
            tstate["current"] = text
            tstate["voice"] = voice_name or "default"
            tstate["queue_len"] = state.tts_queue.qsize()
            _tts_broadcast()

            audio = None
            sr = None
            try:
                audio, sr = _tts_generate(text, voice_path)
            except Exception:
                log.error("[tts] generate failed:\n%s", traceback.format_exc())

            tstate["generating"] = False
            _tts_broadcast()

            if audio is not None:
                tstate["speaking"] = True
                _tts_broadcast()
                broadcast_sync({"type": "tts_say", "text": text, "voice": voice_name or "default"})

                try:
                    _tts_play_audio(audio, sr)
                except Exception:
                    log.error("[tts] playback failed:\n%s", traceback.format_exc())

                tstate["speaking"] = False

        tstate["current"] = ""
        tstate["queue_len"] = state.tts_queue.qsize()
        _tts_broadcast()


def tts_say(text, voice: str | None = None) -> None:
    text = (text or "").strip()
    if not text or state.tts_queue is None:
        return
    state.tts_queue.put((text, voice))
    state.tts_state()["queue_len"] = state.tts_queue.qsize()
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
    try:
        while True:
            state.tts_queue.get_nowait()
    except Exception:
        pass
    state.tts_state()["queue_len"] = 0
    _tts_broadcast()


def tts_set_enabled(enabled: bool) -> None:
    state.tts_state()["enabled"] = enabled
    _tts_broadcast()


def _open_tts_input_popup() -> None:
    """small always-on-top borderless input box, for typing tts lines over
    a borderless windowed game. enter sends + closes, escape cancels."""
    if not state.tts_popup_open.acquire(blocking=False):
        return

    def _run() -> None:
        try:
            import tkinter as tk

            root = tk.Tk()
            root.withdraw()
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            try:
                root.attributes("-alpha", 0.95)
            except Exception:
                pass

            w, h = 520, 56
            sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
            root.geometry(f"{w}x{h}+{(sw - w) // 2}+{int(sh * 0.72)}")

            frame = tk.Frame(root, bg="#101418", highlightbackground="#3fd67a",
                              highlightthickness=2)
            frame.pack(fill="both", expand=True)

            entry = tk.Entry(
                frame, font=("Consolas", 16), bg="#101418", fg="#e6ffe6",
                insertbackground="#e6ffe6", relief="flat", bd=0,
            )
            entry.pack(fill="both", expand=True, padx=14, pady=12)

            def _grab_focus() -> None:
                root.deiconify()
                root.lift()
                root.attributes("-topmost", True)
                root.focus_force()
                entry.focus_force()
                entry.icursor("end")

            root.after(0, _grab_focus)
            root.after(60, _grab_focus)
            root.after(150, _grab_focus)

            def _send(_event=None) -> None:
                text = entry.get().strip()
                if text:
                    tts_say(text)
                root.destroy()

            def _cancel(_event=None) -> None:
                root.destroy()

            entry.bind("<Return>", _send)
            entry.bind("<Escape>", _cancel)
            root.after(300, lambda: root.bind("<FocusOut>", _cancel))

            root.mainloop()
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
