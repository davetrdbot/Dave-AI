"""
Dave's self-hosted AI brain service (Step 5).

A separate Python process from the Node/DSH app (Step 2's rationale:
AirLLM is Python-only, disk-heavy, and re-reads weights from disk on
every generated token -- it doesn't belong colocated with the bot
process). Dave's dave-brain package calls this over HTTP.

Model is loaded lazily on first /generate call so the service can start
and answer /health immediately even while a (very large) model is still
being split/loaded.
"""

import os
import time
import traceback

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("DAVE_AIRLLM_MODEL_ID", "Qwen/Qwen3-235B-A22B")
# Step 5.5 originally defaulted this to "4bit", but the real Step 5 sandbox
# test found AirLLM 3.3.0's compression path hardcodes .cuda() regardless of
# host capability (confirmed by reading the installed package source) --
# it will always raise "Found no NVIDIA driver" on Railway's CPU-only
# hosting, which is the confirmed deployment target. Defaulting to "none"
# (uncompressed, CPU-compatible) so the service actually works out of the
# box; "4bit"/"8bit" remain available for whoever deploys this on a GPU host.
COMPRESSION = os.environ.get("DAVE_AIRLLM_COMPRESSION", "none")
# Also confirmed by real testing: AirLLM's own device default is "cuda:0"
# (its constructor's own default, per airllm_base.py), not auto-detected --
# passing device='cpu' explicitly is what actually got past the CUDA error
# in the real Step 5 sandbox attempt. Must be explicit here too, not relied
# on as some auto-detected default.
DEVICE = os.environ.get("DAVE_AIRLLM_DEVICE", "cpu")

app = FastAPI(title="dave-ai-brain-service")

_model = None
_model_error: str | None = None


class Message(BaseModel):
    role: str
    content: str


class GenerateRequest(BaseModel):
    messages: list[Message]
    max_tokens: int = 512
    compression: str = COMPRESSION


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None, "model_id": MODEL_ID, "last_error": _model_error}


def _load_model(compression: str):
    global _model, _model_error
    from airllm import AutoModel  # imported lazily -- heavy import

    # AirLLM's real signature (confirmed by reading the installed source,
    # airllm_base.py) defaults compression to Python None, not the string
    # "none" -- passing the literal string "none" through would be treated
    # as a real (but unrecognized) compression mode, not "no compression".
    compression_arg = None if compression in ("none", "", None) else compression

    try:
        kwargs = {"device": DEVICE}
        if compression_arg is not None:
            kwargs["compression"] = compression_arg
        _model = AutoModel.from_pretrained(MODEL_ID, **kwargs)
        _model_error = None
    except Exception as exc:  # noqa: BLE001 -- we want the exact real error, not a swallowed one
        _model_error = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        raise


@app.post("/generate")
def generate(req: GenerateRequest):
    global _model
    if _model is None:
        try:
            _load_model(req.compression)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"AirLLM model load failed: {exc}")

    prompt = "\n".join(f"{m.role}: {m.content}" for m in req.messages)
    input_tokens = _model.tokenizer(
        prompt, return_tensors="pt", return_attention_mask=False, truncation=True, max_length=2048, padding=False
    )
    # Real bug fixed here: hasattr(tensor, "cuda") is always True for a
    # standard PyTorch tensor regardless of whether a GPU actually exists
    # -- every CPU-only tensor still HAS a .cuda() method, it just raises
    # "No CUDA GPUs are available" when called. The real check is whether
    # CUDA is actually usable on this host.
    import torch

    input_ids = input_tokens["input_ids"]
    if torch.cuda.is_available() and DEVICE != "cpu":
        input_ids = input_ids.cuda()

    start = time.time()
    output = _model.generate(
        input_ids,
        max_new_tokens=req.max_tokens,
        use_cache=True,
        return_dict_in_generate=True,
    )
    text = _model.tokenizer.decode(output.sequences[0])
    return {"text": text, "latency_s": time.time() - start}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8090")))
