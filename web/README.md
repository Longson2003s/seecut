# SeeCut Studio (local web app)

SeeCut Studio is a local web interface for preparing an edit and running the SeeCut workflow with an OpenAI-compatible AI Local Server. It uses the repository's SeeCut instructions and HyperFrames renderer; it does not replace the skill's hard gates or review process.

## Requirements

- Node.js 22 or newer
- An OpenAI-compatible local server reachable from the web server, with a vision model that supports tool calling
- FFmpeg and ffprobe on `PATH`
- The SeeCut dependencies and tools described in the repository's root README, including ffmpeg for sample extraction and MP4 packaging

The editing pipeline is documented as tested on macOS. Some steps use `zsh`; Windows users may need WSL or macOS. The web interface itself can run on Windows, but that does not make the underlying pipeline Windows-compatible.

## Configure and run

Create a `.env` file in the repository root (it is ignored by Git):

```dotenv
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=your-local-server-key
OPENAI_MODEL=qwen/qwen3.6-35b-a3b
```

Then start the server from the repository root:

```sh
node --env-file=.env web/server.mjs
```

Set the base URL to the OpenAI-compatible `/v1` API root, the model ID to one exposed by `/v1/models`, and the key required by your local server. The key is sent only as a Bearer authorization header; it is not stored in project files or returned by the status endpoint. To use another port, set `PORT`. `SEECUT_DATA_DIR` changes where uploaded media and generated project files are stored; by default, project data lives in `web/data/`, which is excluded from Git.

If the server exposes its native `/api/v0/models` status, the selected model must be loaded before a project can run. SeeCut needs a loaded context of at least 65,536 tokens to fit source frames and workflow references. In LM Studio, load it with `POST /api/v1/models/load` and a JSON body such as `{"model":"qwen/qwen3.6-35b-a3b","context_length":65536}`. Use HTTPS if the AI server is on an untrusted network.

Open <http://127.0.0.1:4173>. The server binds to localhost by default. Do not expose it to a public network.

## Video and privacy

Each project accepts one source video (MP4, MOV, M4V, WebM, or MKV; maximum 4 GB). The source video remains in the local project workspace. FFmpeg extracts up to 24 downscaled JPEG frames across the selected footage and sends those images to the configured AI server for editing and review. Sample mode uses up to the first 30 seconds; full mode samples across the full video. Still frames cannot represent motion or pacing, so model reviews must report this limitation. Local uploads and generated work remain in the configured data directory until you remove them.

Project logs and generated video/report files are available in the web interface.
