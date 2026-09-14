# Third-party notices

quick-titles' own source is MIT (see [LICENSE](LICENSE)). It depends on work by others, and one of
those dependencies is the reason this project exists at all.

**Scope:** the MIT licence in [LICENSE](LICENSE) covers the quick-titles source code only. The title
model weights are a separate work, licensed by Desert Ant Labs, and are not covered by it. That
sentence used to live at the bottom of `LICENSE` itself, which stopped GitHub recognising the file
as MIT — a licence GitHub cannot identify is one that tooling and reviewers report as "Other", so
the scope note belongs here where the third-party licences already are.

## desert-ant-labs/title

The title model is [`desert-ant-labs/title`](https://huggingface.co/desert-ant-labs/title), a
fine-tune of [`ibm-granite/granite-4.0-350m`](https://huggingface.co/ibm-granite/granite-4.0-350m),
licensed under the **Desert Ant Labs Source-Available License 1.0** —
<https://license.desertant.com/1.0>.

quick-titles does not distribute the converted GGUF, and the licence is why. Section 6 says:

> Do not redistribute the Models on their own. You may not sell, sublicense, or distribute the
> Models or SDKs themselves, or a substantially unmodified derivative, as a standalone product,
> model, SDK, or hosted service.

The converted file is a derivative, and Section 2 keeps derivatives under this licence. Offered as a
release asset it would be a substantially unmodified derivative distributed as a standalone model —
readable by any runtime, detached from this application — which is what the clause names. The
counter-argument is Section 6's own closing line, "embedding them in your application and shipping
that application is what this license is for"; that is the reading to put to the licensor if
publishing the weights is ever wanted. Until then, the answer is the one this repository acts on:
the converted weights are excluded from version control by `.gitignore`, and the
[conversion pipeline](docs/model-pipeline.md) runs on the user's machine, from the publisher's own
download, rather than on a release page.

**What would make publishing permissible.** The grant in Section 2 is to "embed and distribute them
**inside your application**", the patent grant in Section 8 is to the Models "as embedded in your
application", and Section 14 speaks of copies "embedded in shipped versions of your application" —
the licence's mental model throughout is weights travelling inside the app's own artefact, not at a
URL beside it. Desert Ant Labs' own SDKs work this way from the other direction: they pin a model
revision on their Hugging Face Hub and fetch it at run time, so the weights stay their download.
The two clean routes are therefore to bundle the GGUF in the shipped package (the licence's literal
wording, though a 380 MB npm tarball is its own problem), or to get a GGUF published on
`desert-ant-labs/title` and point `provision` at it. Section 18 lets a written licence from Desert
Ant Labs control over this one, so hosting is theirs to permit if asked.

**Volume.** Section 3 makes the licence free below **100,000 monthly active devices per Platform,
per Model**, and requires a commercial licence above it. quick-titles ships none of Desert Ant Labs'
SDK, so nothing counts or reports MAD on their behalf — but the threshold is a term of the licence,
not a function of their telemetry, and a widely-installed quick-titles is what would cross it.

Attribution is required too, and appears in:

- this file, and the README
- the daemon startup log
- `quick-titles sessions`
- `quick-titles doctor`

**All credit for the model belongs to Desert Ant Labs.** Every quality result in
`tools/eval/score.md` is a measurement of *their* fine-tune; quick-titles contributes the delivery
path, not the intelligence.

## ggml-org/llama.cpp

Inference runs on [llama.cpp](https://github.com/ggml-org/llama.cpp) through
[node-llama-cpp](https://github.com/withcatai/node-llama-cpp), both MIT licensed.

quick-titles is configured to use prebuilt binaries only (`build: "never"`), so installing it never
compiles llama.cpp from source.

## MLX

The published weights were converted from MLX 6-bit affine quantisation to GGUF q8_0 using
[MLX](https://github.com/ml-explore/mlx), MIT licensed. The conversion is documented in
`docs/model-pipeline.md` and validated by `tools/verify-gguf.mjs`.

## Granite

`granite-4.0-350m` is released by IBM under the Apache 2.0 licence. The Desert Ant Labs licence
above governs the fine-tuned derivative that quick-titles actually uses.
