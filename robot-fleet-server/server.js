// =======================
//  Imports & Setup
// =======================
const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =======================
//  MongoDB Atlas Connection
//  Set MONGODB_URI in Railway → Variables tab:
//  mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/RobotFleetDB?retryWrites=true&w=majority
// =======================
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI environment variable is not set. Exiting.");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB Atlas Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

// =======================
//  Schemas & Models
// =======================
const RobotSchema = new mongoose.Schema({
  _id: String,
  operation: String,
  status: String,
  lastSeen: String,
  battery: Number,
  location: Object,
  ip: String
}, { collection: "robots" });

const UserSchema = new mongoose.Schema({
  username: String,
  password: String  // TODO: store bcrypt hashes, not plain text
}, { collection: "users" });

// Every telemetry packet gets its own document — never overwritten, full history
const TelemetryLogSchema = new mongoose.Schema({
  robotId:   { type: String, index: true },
  timestamp: { type: Date,   default: Date.now, index: true },
  battery:   Number,
  location:  Object,
  speed:     Number,
}, { collection: "telemetry_logs" });

const Robot        = mongoose.model("Robot",        RobotSchema);
const User         = mongoose.model("User",         UserSchema);
const TelemetryLog = mongoose.model("TelemetryLog", TelemetryLogSchema);

// =======================
//  Health Check
//  Railway pings GET / to confirm the app is alive — required
// =======================
app.get("/", (req, res) => res.send("🤖 Robot Fleet Server Online"));

// =======================
//  REST: Query telemetry logs
//  GET /telemetry/:robotId?limit=100&from=2024-01-01&to=2024-12-31
// =======================
app.get("/telemetry/:robotId", async (req, res) => {
  try {
    const { robotId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const filter = { robotId };

    if (req.query.from || req.query.to) {
      filter.timestamp = {};
      if (req.query.from) filter.timestamp.$gte = new Date(req.query.from);
      if (req.query.to)   filter.timestamp.$lte = new Date(req.query.to);
    }

    const logs = await TelemetryLog.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json({ robotId, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =======================
//  WebSocket Logic
// =======================
io.on("connection", (socket) => {
  console.log("⚡ Connected: " + socket.id);

  socket.on("disconnect", async () => {
    if (socket.robotId) {
      await Robot.updateOne({ _id: socket.robotId }, { $set: { status: "offline" } });
      console.log("⚠ Robot Offline: " + socket.robotId);
    } else if (socket.username) {
      console.log("🚪 User Disconnected: " + socket.username);
    } else {
      console.log("🔌 Client Disconnected: " + socket.id);
    }
  });

  // ---- Robot Connects ----
  socket.on("robot_connect", async ({ robotId }) => {
    const robot = await Robot.findById(robotId);
    if (!robot) return socket.emit("auth_failed", "Robot ID not registered");

    socket.join(robotId);
    socket.robotId = robotId;

    await Robot.findByIdAndUpdate(robotId, {
      status: "online",
      lastSeen: new Date().toISOString(),
      ip: socket.handshake.address.replace("::ffff:", "")
    });

    console.log("🤖 Robot Online → " + robotId);
  });

  // ---- Client Checks Robot Status ----
  socket.on("check_robot_status", async ({ robotId }) => {
    const robot = await Robot.findById(robotId);
    if (!robot) return socket.emit("robot_status_response", { exists: false });

    socket.emit("robot_status_response", {
      exists: true,
      status: robot.status,
      lastSeen: robot.lastSeen,
      battery: robot.battery,
      location: robot.location
    });
  });

  // ---- Robot Sends Telemetry ----
  socket.on("robot_telemetry", async ({ robotId, data }) => {
    const now = new Date();

    // 1. Update current robot state (overwrites — always shows latest)
    await Robot.updateOne({ _id: robotId }, {
      $set: {
        battery:  data.battery,
        location: data.location,
        lastSeen: now.toISOString()
      }
    });

    // 2. Append a log entry (never overwritten — full history)
    await TelemetryLog.create({
      robotId,
      timestamp: now,
      battery:   data.battery,
      location:  data.location,
      speed:     data.speed,
    });

    // 3. Forward to operator watching this robot
    io.to("operator_" + robotId).emit("telemetry_update", { robotId, data });
  });

  // ---- Operator Subscribes to a Robot's Telemetry ----
  socket.on("watch_robot", ({ robotId }) => {
    socket.join("operator_" + robotId);
    socket.watchingRobotId = robotId;
    console.log("👁 Operator " + (socket.username || socket.id) + " watching " + robotId);
  });

  // ---- Client Sends Control Command to Robot ----
  socket.on("control_to_robot", ({ robotId, command }) => {
    io.to(robotId).emit("robot_control", command);
  });

  // ---- User Login ----
  socket.on("login_request", async ({ username, password }) => {
    const user = await User.findOne({ username, password });
    if (user) {
      socket.username = username;
      console.log("✅ Login: " + username);
    }
    socket.emit("login_response", { success: !!user });
  });
});

// =======================
//  Start Server
// =======================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log("🌐 Server Online on port " + PORT));