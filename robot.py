import socketio
import time
import os

# ==========================
# CONFIG
# Read SERVER_URL from environment variable so you never hardcode IPs.
# Set it before running:
#   export SERVER_URL=https://your-app.up.railway.app
#   python robot.py
# ==========================
SERVER_URL = os.environ.get("SERVER_URL", "").strip()
ROBOT_ID   = os.environ.get("ROBOT_ID", "ROBOT003").strip()

if not SERVER_URL:
    print("❌ SERVER_URL environment variable is not set.")
    print("   Run as: SERVER_URL=https://your-app.up.railway.app python robot.py")
    exit(1)

print(f"📡 Server : {SERVER_URL}")
print(f"🤖 Robot  : {ROBOT_ID}")

# ==========================

sio = socketio.Client()

# ---------------- SOCKET EVENTS ----------------

@sio.event
def connect():
    print(f"✅ Connected to server")
    sio.emit("robot_connect", {"robotId": ROBOT_ID})


@sio.event
def connect_error(data):
    print("❌ Connection Failed:", data)


@sio.event
def disconnect():
    print("⚠  Disconnected from server")


@sio.on("auth_failed")
def auth_failed(msg):
    print("🚫 Auth Failed:", msg)
    sio.disconnect()


@sio.on("robot_control")
def on_control_command(command):
    print("🎮 Command:", command)
    # TODO: forward to Arduino / motor controller
    # arduino.write(json.dumps(command).encode())


def send_telemetry(battery, x, y, speed):
    sio.emit("robot_telemetry", {
        "robotId": ROBOT_ID,
        "data": {
            "battery": battery,
            "location": {"x": x, "y": y},
            "speed": speed
        }
    })


# ---------------- MAIN ----------------

def main():
    while True:
        try:
            print(f"🔌 Connecting to {SERVER_URL} ...")
            sio.connect(SERVER_URL, transports=["websocket"])
            break
        except socketio.exceptions.ConnectionError as e:
            print(f"❌ Connection error: {e}")
            print("👉 Is the server deployed and running? Is ROBOT_ID registered in MongoDB?")
            print("⏳ Retrying in 3s...\n")
            time.sleep(3)
        except Exception as e:
            print(f"❌ Unexpected error: {e}")
            print("⏳ Retrying in 3s...\n")
            time.sleep(3)

    print("✅ Robot online — sending telemetry every 1s\n")

    while True:
        # Replace with real sensor readings from hardware
        send_telemetry(battery=92, x=5.4, y=-2.1, speed=0.4)
        time.sleep(1)


if __name__ == "__main__":
    main()
