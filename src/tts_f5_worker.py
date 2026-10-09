import argparse
import base64
import contextlib
import importlib
import json
import sys


def respond(**payload) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device")
    args = parser.parse_args()

    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            api_module = importlib.import_module("f5_tts.api")

            model_options = {"model": args.model}
            if args.device:
                model_options["device"] = args.device
            tts = api_module.F5TTS(**model_options)
    except Exception as exc:
        respond(ok=False, error=f"model initialization failed: {exc}")
        return

    respond(ok=True, event="ready")
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("op") == "shutdown":
                break
            if request.get("op") != "generate":
                raise ValueError(f"unsupported operation: {request.get('op')!r}")
            reference_audio = str(request.get("reference_audio", ""))
            reference_text = str(request.get("reference_text", "")).strip()
            if not reference_audio:
                raise ValueError("reference audio is required")
            if not reference_text:
                raise ValueError("reference transcript is required")
            with contextlib.redirect_stdout(sys.stderr):
                result = tts.infer(
                    ref_file=reference_audio,
                    ref_text=reference_text,
                    gen_text=str(request.get("text", "")),
                )
            audio, sample_rate = result[0], result[1]
            samples = np.asarray(audio, dtype=np.float32).squeeze()
            if samples.ndim != 1 or not samples.size or int(sample_rate) <= 0:
                raise ValueError("F5-TTS returned empty audio or an invalid sample rate")
            encoded = base64.b64encode(
                np.ascontiguousarray(samples, dtype="<f4").tobytes()
            ).decode("ascii")
            respond(ok=True, audio=encoded, sample_rate=int(sample_rate))
        except Exception as exc:
            respond(ok=False, error=f"generation failed: {exc}")


if __name__ == "__main__":
    main()
