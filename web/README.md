# SeeCut Studio (local web app)

SeeCut Studio is a local web interface for preparing an edit and running the SeeCut workflow with Gemini. It uses the repository's SeeCut instructions and HyperFrames renderer; it does not replace the skill's hard gates or review process.

## Requirements

- Node.js 22 or newer
- A Gemini API key with API access. Create one in [Google AI Studio](https://aistudio.google.com/apikey).
- The SeeCut dependencies and tools described in the repository's root README, including ffmpeg for sample extraction and MP4 packaging

The editing pipeline is documented as tested on macOS. Some steps use `zsh`; Windows users may need WSL or macOS. The web interface itself can run on Windows, but that does not make the underlying pipeline Windows-compatible.

## Configure and run

Create a `.env` file in the repository root (it is ignored by Git):

```dotenv
GEMINI_API_KEY=your-key
# Optional:
# GEMINI_MODEL=gemini-2.5-flash
# GEMINI_MAX_UPLOAD_BYTES=2147483648
```

Then start the server from the repository root:

```sh
node --env-file=.env web/server.mjs
```

Alternatively, set `GEMINI_API_KEY` in the server process environment before running `node web/server.mjs`. The API key is not stored in project files or returned by the status endpoint. To use another port, set `PORT`. `SEECUT_DATA_DIR` changes where uploaded media and generated project files are stored; by default, project data lives in `web/data/`, which is excluded from Git.

Open <http://127.0.0.1:4173>. The server binds to localhost by default. Do not expose it to a public network.

## Video and privacy

Each project accepts one source video (MP4, MOV, M4V, WebM, or MKV; maximum 4 GB). The **sample** option extracts and sends up to the first 30 seconds; the **full video** option sends the full source. Gemini receives the selected video through its Files API for editing and review. Temporary Gemini files are deleted after use on a best-effort basis; local uploads and generated work remain in the configured data directory until you remove them.

The default Gemini upload limit is 2 GiB (`GEMINI_MAX_UPLOAD_BYTES`). The effective limit is also subject to the model and API limits on your Google account. Project logs and generated video/report files are available in the web interface.
