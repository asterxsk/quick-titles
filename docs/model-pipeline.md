# Model pipeline: MLX 6-bit to Q8_0 GGUF

The title model is published as MLX weights, which only run on Apple silicon. Shipping
runtime is `node-llama-cpp`, which needs GGUF. Conversion therefore happens on a GitHub
Actions macOS runner (`.github/workflows/convert-model.yml`, `runs-on: macos-14`), never on
a user's machine.

## Exact commands

Run in order by the workflow:

```
python -m pip install --upgrade pip
pip install mlx-lm huggingface_hub
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
pip install -r llama.cpp/requirements.txt

huggingface-cli download desert-ant-labs/title --local-dir mlx-model

# assert quantization.bits == 6 and quantization.group_size == 64

mlx_lm.convert --hf-path mlx-model --mlx-path title-bf16 \
  --dequantize --dtype bfloat16

python llama.cpp/convert_hf_to_gguf.py title-bf16 \
  --outfile title-f16.gguf --outtype f16

cmake -S llama.cpp -B llama.cpp/build -DLLAMA_CURL=OFF
cmake --build llama.cpp/build --config Release -j --target llama-quantize
./llama.cpp/build/bin/llama-quantize title-f16.gguf title-q8_0.gguf Q8_0

node tools/verify-gguf.mjs title-q8_0.gguf
shasum -a 256 title-q8_0.gguf | tee title-q8_0.gguf.sha256
```

## Build result

Not yet recorded. The macOS CI job has not been run from this working tree (no GitHub
remote is configured here); the workflow is triggered with:

```
gh workflow run convert-model.yml && gh run watch
```

After the first green run, fill in the fields below from the run's artifact. Later tasks
pin the daemon's fetch against the SHA-256 recorded here.

| Field | Value |
|---|---|
| Source commit SHA converted | _pending first CI run_ |
| Artifact `title-q8_0.gguf` size | _pending first CI run_ |
| Full SHA-256 (`title-q8_0.gguf.sha256`) | _pending first CI run_ |

## Notes

- Ship precision is **Q8_0**. The source is already 6-bit; f16 buys nothing real and Q6_K
  stacks a second quantisation on top of the first.
- `tools/verify-gguf.mjs` asserts the GGUF architecture is `granitehybrid` and that it
  carries a non-empty `tokenizer.chat_template`, then prints `OK`.
- The GGUF is a GitHub release asset fetched by the daemon at first start. It is not
  published as a standalone downloadable model (Desert Ant Labs Source-Available License 1.0).
