"""Export opus-mt-tc-big-he-en to int8 ONNX for the offline engine.

This is the recipe that produced public/models/opus-mt-tc-big-he-en. Every step
below is load-bearing; the obvious version of this script does not work.

    pip install "optimum[onnxruntime]==1.24.0" onnxscript transformers sentencepiece
    python scripts/convert-opus-int8.py path/to/helsinki path/to/tokenizer.json

Arguments:
  helsinki       A local copy of https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-he-en
                 (model.safetensors, config.json, vocab.json, *.spm, the small JSONs).
  tokenizer.json From https://huggingface.co/nico-martin/opus-mt-tc-big-he-en —
                 see the note below.

Output: public/models/opus-mt-tc-big-he-en/, ready for PRESET = 'he-en'.

Why each pin:

* optimum **1.24**, not 2.x. Optimum 2 reworked the seq2seq exporter and emits a
  decoder with no KV-cache inputs and no decoder_model_merged.onnx, which
  transformers.js requires by name.
* **onnxscript** must be installed or optimum 1.24 fails on import.
* torch.onnx.export is forced back to the **legacy TorchScript path**. From
  torch 2.9 the dynamo exporter is the default, and it writes external weights
  as "<name>.onnx_data" while optimum 1.24 looks for "<name>.onnx.data".
* **EnableSubgraph** on quantisation. The merged decoder puts both cache
  branches inside an If node; without it the MatMuls in those subgraphs stay
  fp32 and the file barely shrinks.
* **tokenizer.json is not produced here.** Marian has no fast tokenizer, so
  optimum only writes source.spm/target.spm, which transformers.js cannot read.
  nico-martin's file is derived from this same model, which beats writing a
  SentencePiece-to-tokenizers converter.

Needs roughly 10 GB of RAM. The with-past decoder export was OOM-killed at 7 GB;
add swap if the process dies with exit code 137.
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "models" / "opus-mt-tc-big-he-en"
WORK = ROOT / ".opus-export"

COPY = (
    "config.json",
    "generation_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "source.spm",
    "target.spm",
)


def patch_torch_export() -> None:
    import functools

    import torch

    original = torch.onnx.export

    @functools.wraps(original)
    def legacy(*args, **kwargs):
        kwargs["dynamo"] = False
        return original(*args, **kwargs)

    torch.onnx.export = legacy


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    source, tokenizer_json = Path(sys.argv[1]), Path(sys.argv[2])
    for p in (source, tokenizer_json):
        if not p.exists():
            sys.exit(f"not found: {p}")

    patch_torch_export()
    from optimum.exporters.onnx import main_export

    print(f"exporting {source} -> {WORK}", flush=True)
    main_export(str(source), output=str(WORK), task="text2text-generation-with-past", device="cpu")

    from onnxruntime.quantization import QuantType, quantize_dynamic

    (OUT / "onnx").mkdir(parents=True, exist_ok=True)
    for name in ("encoder_model", "decoder_model_merged"):
        src = WORK / f"{name}.onnx"
        if not src.exists():
            sys.exit(f"missing {src} — the export layout changed; check the optimum version")
        dst = OUT / "onnx" / f"{name}_quantized.onnx"
        print(f"quantising {src.name} -> {dst.name}", flush=True)
        quantize_dynamic(
            model_input=str(src),
            model_output=str(dst),
            weight_type=QuantType.QUInt8,
            per_channel=False,
            reduce_range=False,
            extra_options={"EnableSubgraph": True},
        )

    for name in COPY:
        found = WORK / name
        if found.exists():
            shutil.copy2(found, OUT / name)
        else:
            print(f"note: {name} not produced by the export", flush=True)
    shutil.copy2(tokenizer_json, OUT / "tokenizer.json")

    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"\ndone: {OUT} ({total / 1e6:.0f} MB)")
    print(f"Delete {WORK} when you're happy with the result.")


if __name__ == "__main__":
    main()
