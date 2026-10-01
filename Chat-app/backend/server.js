require("dotenv").config();
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

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((e) => console.log("Mongo error:", e.message));

// Database shapes
const User = mongoose.model("User", new mongoose.Schema({ username: { type: String, unique: true } }));
const Message = mongoose.model("Message", new mongoose.Schema(
  { from: String, to: String, text: String }, { timestamps: true }));

// REST routes
app.post("/api/login", async (req, res) => {
  const username = (req.body.username || "").trim().toLowerCase();
  if (!username) return res.status(400).json({ error: "Username required" });
  const user = await User.findOneAndUpdate({ username }, { username }, { upsert: true, new: true });
  res.json(user);
});
app.get("/api/users", async (req, res) => res.json(await User.find()));
app.get("/api/messages/:a/:b", async (req, res) => {
  const { a, b } = req.params;
  res.json(await Message.find({ $or: [{ from: a, to: b }, { from: b, to: a }] }).sort("createdAt"));
});

// Real-time: chat + call signaling
const online = {}; // username -> socket id
io.on("connection", (socket) => {
  socket.on("join", (u) => {
    socket.username = u;
    online[u] = socket.id;
    io.emit("online", Object.keys(online));
  });
  socket.on("message", async ({ from, to, text }) => {
    const m = await Message.create({ from, to, text });
    socket.emit("message", m);
    if (online[to]) io.to(online[to]).emit("message", m);
  });
  // WebRTC signaling: server only forwards messages between the two users
  ["call-offer", "call-answer", "ice", "call-end"].forEach((ev) =>
    socket.on(ev, (d) => {
      if (online[d.to]) io.to(online[d.to]).emit(ev, { ...d, from: socket.username });
    }));
  socket.on("disconnect", () => {
    delete online[socket.username];
    io.emit("online", Object.keys(online));
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
