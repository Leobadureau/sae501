# Scene Viewer

A standalone viewer for your exported Marble scene, powered by [SparkJS](https://sparkjs.dev).

## Quickstart

To view your scene locally, you'll need to serve the files over HTTP (opening `index.html` directly won't work).

### Using Python

The easiest way is to use Python's built-in HTTP server:

```bash
# Navigate to this folder in your terminal
cd /path/to/your/exported/scene

# Start the server
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

### Using Node.js

Alternatively, if you have Node.js installed:

```bash
npx serve .
```

## Files

- `index.html` – The viewer HTML file
- `spark.module.min.js` – The SparkJS rendering library
- `scene.json` – Scene manifest containing transforms and file references
- `*.spz` – Compressed gaussian splat files
- `*.glb` – 3D mesh files (if applicable)

## Resources

For more information on SparkJS and its capabilities, here are some places to start:

- **SparkJS Documentation**: https://sparkjs.dev/docs
- **SparkJS Examples (Demos)**: https://sparkjs.dev/examples/ 
- **SparkJS Examples (Source Code)**: https://github.com/sparkjsdev/spark/tree/main/examples
- **SparkJS Discord**: https://discord.gg/DxubkP8D