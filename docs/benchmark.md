# Benchmark: the bundled int8 model vs Helsinki's original

The offline engine ships a dynamically-quantised int8 ONNX export of
`Helsinki-NLP/opus-mt-tc-big-he-en`. Quantisation is lossy, so the question is
how much quality it costs against the fp32 model the published scores come from.

## Method

Helsinki ship `benchmark_translations.zip` in the model repo. Its `.compare`
files hold, for every test sentence, the source Hebrew, the reference English,
**and their own fp32 Marian output** — the exact hypotheses that scored 53.8
BLEU. That makes a like-for-like comparison possible without re-running their
system.

Scored with sacrebleu 2.x (`BLEU|nrefs:1|case:mixed|tok:13a`, `chrF2`), the same
configuration named in their `.eval` files. Scoring their hypotheses reproduces
the published numbers to within rounding (53.81 vs 53.8; 44.04 vs 44.1), which
is the check that the harness is measuring the right thing.

## FLORES-101 devtest (1012 sentences)

| System | BLEU | Δ | chrF2 |
|---|---|---|---|
| Helsinki fp32, beam 4 (published) | 44.04 | — | 0.6811 |
| fp32, greedy (PyTorch) | 43.86 | −0.18 | 0.6786 |
| **int8, greedy — what ships** | **43.20** | **−0.84** | 0.6745 |

Splitting the two causes:

- **beam → greedy: −0.18 BLEU.** Smaller than the usual penalty, and not a
  choice: `num_beams` has no effect in transformers.js. Passing `num_beams: 4`
  produced byte-identical output to greedy on all 1012 sentences.
- **fp32 → int8: −0.66 BLEU.** The actual cost of the quantisation.

58% of int8 outputs are byte-identical to fp32 greedy.

## Tatoeba test v2021-08-07 (10519 sentences)

| System | BLEU | Δ | chrF2 |
|---|---|---|---|
| Helsinki fp32, beam 4 (published) | 53.81 | — | 0.6857 |
| **int8, greedy — what ships** | **52.46** | **−1.35** | 0.6780 |

−2.5% relative, on short conversational sentences where a single word choice
moves the score more than it does on FLORES's longer news text.

## Reading it

The quantised model is within about one BLEU point of the original — a real but
small loss, and far smaller than the gap to any model small enough to be a
comfortable download. For comparison, `Xenova/opus-mt-mul-en` (the ~112 MB
fallback preset) is a general multilingual model, not a Hebrew specialist.

Throughput, measured on the same runs: ~20 sentences/s on short Tatoeba
sentences, ~10/s on longer FLORES ones, single-threaded on CPU via
onnxruntime-node. In the extension the WASM backend is somewhat slower, and the
visible-first queue plus the persistent cache matter more than raw speed.

## Reproducing

```bash
pip install sacrebleu
# unzip benchmark_translations.zip from the Helsinki repo, parse the .compare
# files into {src, ref, hyp}, run public/models/... over src, score against ref
```

The parsing is four-line groups: source, reference, hypothesis, blank.
