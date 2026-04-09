const io = require("socket.io-client");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const readline = require("readline");

// ================= CONFIG ==================
// Set SERVER_URL to your Railway deployment URL, e.g.:
//   SERVER_URL=https://your-app.up.railway.app node client.js
const SERVER_URL = process.env.SERVER_URL || (() => {
  console.error("❌ SERVER_URL not set.");
  console.error("   Run as: SERVER_URL=https://your-app.up.railway.app node client.js");
  process.exit(1);
})();

let ROBOT_ID = null;
let port = null;
let joystickConnected = false;
let loggedIn = false;
let rawModeActive = false;

// ================= INPUT HELPERS ==================
// readline and setRawMode conflict — pause raw mode during all prompts
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function askQuestion(prompt) {
  return new Promise((resolve) => {
    if (rawModeActive) {
      process.stdin.setRawMode(false);
      rawModeActive = false;
    }
    rl.question(prompt, (answer) => resolve(answer));
  });
}

function enableHotkeys() {
  if (!rawModeActive) {
    process.stdin.setRawMode(true);
    rawModeActive = true;
  }
}

// ================= CONNECT TO CLOUD SERVER ==================
const socket = io(SERVER_URL, {
  transports: ["websocket"],   // Railway works best with websocket transport
  reconnectionAttempts: 10,
  reconnectionDelay: 2000
});

socket.on("connect", () => {
  console.log(`🔗 Connected to server: ${SERVER_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`❌ Cannot reach server: ${err.message}`);
  console.error("👉 Check your SERVER_URL and that the Railway deployment is running.");
});

socket.on("disconnect", (reason) => {
  console.log(`\n⚠️  Disconnected from server: ${reason}`);
  joystickConnected = false;
});

// ================= LOGIN ==================
async function login() {
  const username = await askQuestion("👤 Username: ");
  const password = await askQuestion("🔑 Password: ");
  socket.emit("login_request", { username, password });
}

socket.on("login_response", async ({ success }) => {
  if (!success) {
    console.log("❌ Login failed. Try again.\n");
    return login();
  }
  console.log("✅ Login Successful");
  loggedIn = true;
  await askRobotID();
});

// ================= SELECT ROBOT ==================
async function askRobotID() {
  const id = await askQuestion("\nEnter Robot ID to connect: ");
  ROBOT_ID = id.trim();
  console.log(`🔗 Checking robot ${ROBOT_ID}...`);
  socket.emit("check_robot_status", { robotId: ROBOT_ID });
}

socket.on("robot_status_response", async ({ exists, status, lastSeen, battery, location }) => {
  if (!exists) {
    console.log("🚫 Robot ID not found in system.");
    return askRobotID();
  }

  if (status !== "online") {
    console.log(`⚠  Robot is OFFLINE
    Last Seen: ${lastSeen}
    Battery:   ${battery}%
    Location:  ${JSON.stringify(location)}`);
    return askRobotID();
  }

  console.log(`✅ Robot ${ROBOT_ID} is ONLINE.`);

  // Subscribe to this robot's telemetry stream
  socket.emit("watch_robot", { robotId: ROBOT_ID });

  await askArduinoPort();
  enableHotkeys();
  console.log("\n💡 Hotkeys active — Ctrl+E: switch robot | Ctrl+O: logout | Ctrl+C: exit\n");
});

// ================= ARDUINO ==================
async function askArduinoPort() {
  const portName = await askQuestion("🔌 Enter Arduino Port (e.g. COM5 or /dev/ttyUSB0): ");
  await tryArduinoConnect(portName.trim());
}

function tryArduinoConnect(portName) {
  return new Promise((resolve) => {
    console.log(`⏳ Connecting to Arduino on ${portName}...`);

    port = new SerialPort({ path: portName, baudRate: 115200 }, async (err) => {
      if (err) {
        if (err.message.includes("File not found") || err.message.includes("ENOENT")) {
          console.log(`❌ Port "${portName}" not found.\n`);
        } else if (err.message.includes("busy") || err.message.includes("Access is denied")) {
          console.log(`⚠️  Port "${portName}" is busy.\n`);
        } else {
          console.log(`❌ ${err.message}\n`);
        }
        await askArduinoPort();
        return resolve();
      }
      setupArduinoConnection(port);
      resolve();
    });
  });
}

function setupArduinoConnection(port) {
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  joystickConnected = true;

  console.log("✅ Arduino Connected!");
  console.log("🎮 Joystick active — sending commands to robot...\n");

  parser.on("data", handleJoystickData);

  port.on("close", async () => {
    console.log("⚠️  Arduino Disconnected!");
    joystickConnected = false;
    await askArduinoPort();
    enableHotkeys();
  });

  port.on("error", async (err) => {
    console.log(`❌ Arduino Error: ${err.message}`);
    joystickConnected = false;
    await askArduinoPort();
    enableHotkeys();
  });
}

// ================= JOYSTICK PARSING ==================
function handleJoystickData(line) {
  try {
    line = line.trim();

    // Format from Arduino: 2, [500, 600], [300, 400], 0
    const regex = /^(\d+), \[(\d+), (\d+)\], \[(\d+), (\d+)\], (\d+)$/;
    const match = line.match(regex);
    if (!match) return;

    const mode      = Number(match[1]);
    const yl        = Number(match[3]);   // left stick Y = throttle
    const xr        = Number(match[4]);   // right stick X = steering
    const yr        = Number(match[5]);   // right stick Y = brake trigger
    const direction = Number(match[6]);

    const center = 512;
    let rpm = 0;
    if (yl > center) {
      rpm = Math.floor(((yl - center) / (1023 - center)) * 200);      // forward: 0–200
    } else if (yl < center) {
      rpm = Math.floor(((center - yl) / center) * 300 + 200);          // reverse: 200–500
    }

    const command = {
      robot_id:    ROBOT_ID,
      mode:        mode === 0 ? "automatic" : mode === 1 ? "stop" : "manual",
      direction:   direction === 0 ? "forward" : "backward",
      brake:       yr < 100,
      rpm:         rpm,
      steer_angle: Math.floor((xr / 1023) * 60)
    };

    socket.emit("control_to_robot", { robotId: ROBOT_ID, command });

  } catch (_) {
    // ignore malformed lines
  }
}

// ================= TELEMETRY ==================
socket.on("telemetry_update", ({ robotId, data }) => {
  if (robotId === ROBOT_ID && joystickConnected) {
    console.log(`[📡 ${robotId}]`, data);
  }
});

// ================= HOTKEYS ==================
process.stdin.on("data", async (key) => {
  if (!rawModeActive) return;

  // Ctrl+E → switch robot
  if (key.toString() === "\x05") {
    console.log("\n🔌 Disconnecting from robot...");
    ROBOT_ID = null;
    joystickConnected = false;
    await askRobotID();
    enableHotkeys();
  }

  // Ctrl+O → logout
  if (key.toString() === "\x0F") {
    console.log("\n🚪 Logging out...");
    loggedIn = false;
    ROBOT_ID = null;
    joystickConnected = false;
    await login();
    enableHotkeys();
  }

  // Ctrl+C → exit
  if (key.toString() === "\x03") {
    console.log("\n👋 Exiting.");
    process.exit(0);
  }
});

// ================= START ==================
console.clear();
console.log("🚀 Robot Client Ready");
console.log(`📡 Server: ${SERVER_URL}\n`);
login();
