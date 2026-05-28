# Test suite

Regression and unit tests for Starling. Backend tests run without any
external services (no llama-server, no ollama, no internet).

## Run

```bash
pip install pytest
make test-unit           # fast: unit + regression tests only
make test                # legacy: end-to-end integration vs a live backend
```

Or directly:

```bash
pytest tests/ -v
```

## Layout

| file                         | what it covers                                       |
| ---------------------------- | ---------------------------------------------------- |
| `test_file_utils.py`         | atomic write helpers                                 |
| `test_gpu_init.py`           | Nvidia DLL registration safety                       |
| `test_llm_rag_injection.py`  | RAG + memory context insertion ordering & no-ops     |
| `test_dream_pipeline.py`     | dream-state helpers (`_iso_ts`, `_timed_out`, etc.)  |
| `test_frontend_smoke.py`     | `node --check` parses every `frontend/*.js`          |

`conftest.py` puts `backend/` on `sys.path` so tests can import backend
modules without installing the project as a package.

## Adding tests

When adding a new backend module, please:

1. Add a corresponding `tests/test_<module>.py` with at least one
   smoke test that imports the module and exercises its public API.
2. Mock external services (`rag`, `requests`, `httpx`) using
   `monkeypatch.setitem(sys.modules, ...)` — see
   `test_llm_rag_injection.py` for the pattern.
3. Keep tests offline. Network calls must be patched.
