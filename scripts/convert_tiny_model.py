"""Convert tarteel-ai/whisper-tiny-ar-quran (Apache-2.0) into the layout
transformers.js loads, and ship it inside the app (assets/models/...).

Why: the base model (iqbalaesthetic/Basira, ~100 MB, downloaded once) costs
~0.8 s fixed + ~40 ms per token per call on a laptop CPU, and the model
writes fully diacritized text (many tokens), so the highlight lagged 3-9 s.
Whisper tiny is ~3x cheaper per call and small enough (~40 MB int8) to live
in the repo: no download, works offline from the first visit.

Needs (dev only, NOT the app): torch==2.5.1 (cpu), optimum[onnxruntime]==1.27,
transformers<4.50, accelerate, numpy matching the system build (Smart App
Control blocked a newer numpy DLL). Run with that interpreter:
    python scripts/convert_tiny_model.py
"""
import json, os, shutil, sys, tempfile

from optimum.exporters.onnx import main_export
from onnxruntime.quantization import QuantType, quantize_dynamic
from optimum.onnx import merge_decoders
from transformers import AutoTokenizer, WhisperProcessor

SRC = "tarteel-ai/whisper-tiny-ar-quran"
APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(APP, "assets", "models", "whisper-tiny-ar-quran")


def main():
    tmp = tempfile.mkdtemp(prefix="wtq_")
    main_export(SRC, output=tmp, task="automatic-speech-recognition-with-past", opset=17,
                no_post_process=True)  # keep decoder + decoder_with_past separate (merged below)
    os.makedirs(os.path.join(OUT, "onnx"), exist_ok=True)
    # int8 weights. Encoder: MatMul/Gemm only (ONNX Runtime Web has no
    # ConvInteger, so its two input convolutions stay float). Decoder: also
    # Gather = the 51,865 x 384 token-embedding table, most of its size.
    # Order matters: quantize the two plain decoders FIRST, then merge them;
    # merge_decoders de-duplicates the weights they share. (Quantizing the
    # already-merged file duplicated them per branch: 118 MB instead of ~30.)
    q = lambda src, dst, ops: quantize_dynamic(src, dst, op_types_to_quantize=ops,
                                               weight_type=QuantType.QInt8, per_channel=False, reduce_range=False)
    q(os.path.join(tmp, "encoder_model.onnx"), os.path.join(OUT, "onnx", "encoder_model_quantized.onnx"), ["MatMul", "Gemm"])
    # float32 encoder too (~33 MB): int8 ops fall back to the CPU under WebGPU,
    # so the GPU path needs this one (its float32 output matches the int8 decoder)
    shutil.copy(os.path.join(tmp, "encoder_model.onnx"), os.path.join(OUT, "onnx", "encoder_model.onnx"))
    for name in ("decoder_model", "decoder_with_past_model"):
        q(os.path.join(tmp, name + ".onnx"), os.path.join(tmp, name + "_q.onnx"), ["MatMul", "Gemm", "Gather"])
    merge_decoders(os.path.join(tmp, "decoder_model_q.onnx"), os.path.join(tmp, "decoder_with_past_model_q.onnx"),
                   save_path=os.path.join(OUT, "onnx", "decoder_model_merged_quantized.onnx"), strict=False)
    # configs + tokenizer (tokenizer.json is built from vocab/merges by the fast tokenizer)
    for f in ("config.json", "generation_config.json", "preprocessor_config.json"):
        if os.path.exists(os.path.join(tmp, f)):
            shutil.copy(os.path.join(tmp, f), OUT)
    tok = AutoTokenizer.from_pretrained(SRC)
    tok.save_pretrained(OUT)
    WhisperProcessor.from_pretrained(SRC).feature_extractor.save_pretrained(OUT)
    with open(os.path.join(OUT, "SOURCE.txt"), "w", encoding="utf-8") as fh:
        fh.write(f"Converted from https://huggingface.co/{SRC} (Apache-2.0) by scripts/convert_tiny_model.py\n"
                 "ONNX export: optimum, task automatic-speech-recognition-with-past, opset 17\n"
                 "Quantization: onnxruntime dynamic int8, MatMul/Gemm only\n")
    shutil.rmtree(tmp, ignore_errors=True)
    for root, _, files in os.walk(OUT):
        for f in files:
            p = os.path.join(root, f)
            print(f"{os.path.relpath(p, OUT):45s} {os.path.getsize(p) / 1e6:8.2f} MB")


if __name__ == "__main__":
    sys.exit(main())
