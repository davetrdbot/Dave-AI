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
COMPRESSION = os.environ.get("DAVE_AIRLLM_COMPRESSION", "4bit")  # Step 5.5

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

    try:
        _model = AutoModel.from_pretrained(MODEL_ID, compression=compression)
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
    start = time.time()
    output = _model.generate(
        input_tokens["input_ids"].cuda() if hasattr(input_tokens["input_ids"], "cuda") else input_tokens["input_ids"],
        max_new_tokens=req.max_tokens,
        use_cache=True,
        return_dict_in_generate=True,
    )
    text = _model.tokenizer.decode(output.sequences[0])
    return {"text": text, "latency_s": time.time() - start}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8090")))
