const express = require("express");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── startup check ─────────────────────────────────────────────────────────
try {
  execSync("docker info", { stdio: "ignore" });
} catch {
  console.error("Docker is not running. Please start Docker Desktop and try again.");
  process.exit(1);
}

const SHELL_SCRIPT = path.resolve(__dirname, "./setup.sh").replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);

// ── state ─────────────────────────────────────────────────────────────────
const activeProcesses = {};
const sseClients = {};

function toUnixPath(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

function broadcast(id, obj) {
  const set = sseClients[id];
  if (!set || set.size === 0) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of set) {
    try { res.write(line); } catch (_) {}
  }
}

function isContainerRunning(name) {
  try {
    const out = execSync(
      `docker ps --filter "name=^${name}$" --filter "status=running" --format "{{.Names}}"`,
      { encoding: "utf8" }
    ).trim();
    return out === name;
  } catch (_) {
    return false;
  }
}

// ── folder picker ─────────────────────────────────────────────────────────
app.get("/pick-folder", (req, res) => {
  let command;

  if (process.platform === "win32") {
    // Windows — PowerShell folder picker dialog
    command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`;
  } else if (process.platform === "darwin") {
    // macOS — osascript folder picker
    command = `osascript -e 'POSIX path of (choose folder)'`;
  } else {
    // Linux — zenity folder picker
    command = `zenity --file-selection --directory`;
  }

  try {
    const result = execSync(command, { encoding: "utf8" }).trim();
    if (!result) return res.json({ cancelled: true });
    res.json({ path: result });
  } catch (_) {
    res.json({ cancelled: true });
  }
});

// ── validate folder ───────────────────────────────────────────────────────
app.get("/validate-folder", (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).json({ error: "No path provided" });

  const hasDockerfile = fs.existsSync(path.join(folderPath, "Dockerfile"));
  res.json({ valid: hasDockerfile, path: folderPath });
});

// ── SSE  GET /status/:id ──────────────────────────────────────────────────
app.get("/status/:id", (req, res) => {
  const { id } = req.params;

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  if (!sseClients[id]) sseClients[id] = new Set();
  sseClients[id].add(res);

  const running = !!activeProcesses[id] || isContainerRunning(id);
  res.write(`data: ${JSON.stringify({ type: "state", running })}\n\n`);

  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); }
  }, 20_000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients[id]?.delete(res);
  });
});

// ── start  POST /start ────────────────────────────────────────────────────
app.post("/start", (req, res) => {
  const { projectDir, containerName, hostPort, containerPort } = req.body;

  if (!projectDir || !containerName || !hostPort || !containerPort) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!fs.existsSync(path.join(projectDir, "Dockerfile"))) {
    return res.status(400).json({ error: "No Dockerfile found in selected folder" });
  }

  if (activeProcesses[containerName]) {
    return res.status(409).json({ error: "Already running" });
  }

  res.json({ ok: true, id: containerName });

  broadcast(containerName, { type: "status", phase: "preparing", message: "Preparing to start..." });

  setTimeout(() => {
    broadcast(containerName, { type: "status", phase: "preparing", message: "Building Docker image..." });

    const unixDir = toUnixPath(projectDir);

    const child = spawn("bash", [
      SHELL_SCRIPT,
      unixDir,
      containerName,
      String(hostPort),
      String(containerPort)
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeProcesses[containerName] = child;

    child.stdout.on("data", (d) => {
      const text = d.toString();
      broadcast(containerName, { type: "log", stream: "stdout", text });

      if (text.includes("Done.")) {
        broadcast(containerName, {
          type: "status",
          phase: "running",
          message: `Running on http://localhost:${hostPort}`,
        });
      }
    });

    child.stderr.on("data", (d) => {
      broadcast(containerName, { type: "log", stream: "stderr", text: d.toString() });
    });

    child.on("close", (code) => {
      delete activeProcesses[containerName];
      if (code !== 0) {
        broadcast(containerName, { type: "status", phase: "error", message: `Script exited with code ${code}` });
        broadcast(containerName, { type: "state", running: false });
      }
    });

    child.on("error", (err) => {
      delete activeProcesses[containerName];
      broadcast(containerName, { type: "status", phase: "error", message: err.message });
      broadcast(containerName, { type: "state", running: false });
    });
  }, 600);
});

// ── stop  POST /stop ──────────────────────────────────────────────────────
app.post("/stop", (req, res) => {
  const { containerName, hostPort } = req.body;
  if (!containerName) return res.status(400).json({ error: "Missing containerName" });

  res.json({ ok: true });

  broadcast(containerName, { type: "status", phase: "stopping", message: "Stopping container..." });

  if (activeProcesses[containerName]) {
    activeProcesses[containerName].kill();
    delete activeProcesses[containerName];
  }

  const stopper = spawn("bash", ["-c",
    `docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`
  ]);

  stopper.on("close", () => {
    broadcast(containerName, { type: "status", phase: "idle", message: "Stopped" });
    broadcast(containerName, { type: "state", running: false });
  });

  stopper.on("error", (err) => {
    broadcast(containerName, { type: "status", phase: "idle", message: `Stop failed: ${err.message}` });
    broadcast(containerName, { type: "state", running: false });
  });
});

// ── boot ──────────────────────────────────────────────────────────────────
const PORT = 3333;
app.listen(PORT, () =>
  console.log(`Launcher -> http://localhost:${PORT}`)
);