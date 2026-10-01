import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const socket = io(API, { autoConnect: false });
const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export default function App() {
  const [me, setMe] = useState(localStorage.getItem("me") || "");
  const [name, setName] = useState("");
  const [users, setUsers] = useState([]);
  const [online, setOnline] = useState([]);
  const [peer, setPeer] = useState(null);       // who I'm chatting with
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [call, setCall] = useState(null);       // {peer, status, video, offer}

  const peerRef = useRef(null);
  const pc = useRef(null), stream = useRef(null), pending = useRef([]);
  const localV = useRef(null), remoteV = useRef(null), bottom = useRef(null);
  peerRef.current = peer;

  // ---------- login ----------
  async function login() {
    if (!name.trim()) return;
    const { data } = await axios.post(API + "/api/login", { username: name });
    localStorage.setItem("me", data.username);
    setMe(data.username);
  }
  function logout() { localStorage.removeItem("me"); location.reload(); }

  // ---------- connect socket ----------
  useEffect(() => {
    if (!me) return;
    socket.connect();
    socket.emit("join", me);
    const loadUsers = () => axios.get(API + "/api/users").then((r) => setUsers(r.data.filter((u) => u.username !== me)));
    loadUsers();

    socket.on("online", (list) => { setOnline(list); loadUsers(); });
    socket.on("message", (m) => {
      const p = peerRef.current;
      if (p && (m.from === p || m.to === p)) setMsgs((old) => [...old, m]);
    });
    socket.on("call-offer", ({ from, offer, video }) => setCall({ peer: from, status: "incoming", video, offer }));
    socket.on("call-answer", async ({ answer }) => {
      await pc.current?.setRemoteDescription(answer);
      await flushIce();
      setCall((c) => c && { ...c, status: "active" });
    });
    socket.on("ice", async ({ candidate }) => {
      if (pc.current?.remoteDescription) await pc.current.addIceCandidate(candidate);
      else pending.current.push(candidate);
    });
    socket.on("call-end", () => endCall(false));
    return () => { socket.off(); socket.disconnect(); };
  }, [me]);

  // ---------- load chat history ----------
  useEffect(() => {
    if (peer) axios.get(`${API}/api/messages/${me}/${peer}`).then((r) => setMsgs(r.data));
  }, [peer]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  useEffect(() => { if (localV.current && stream.current) localV.current.srcObject = stream.current; }, [call]);

  function send() {
    if (!text.trim()) return;
    socket.emit("message", { from: me, to: peer, text });
    setText("");
  }

  // ---------- calling (WebRTC) ----------
  async function flushIce() {
    for (const c of pending.current) await pc.current.addIceCandidate(c);
    pending.current = [];
  }
  function newPC(to) {
    const p = new RTCPeerConnection(ICE);
    p.onicecandidate = (e) => e.candidate && socket.emit("ice", { to, candidate: e.candidate });
    p.ontrack = (e) => { if (remoteV.current) remoteV.current.srcObject = e.streams[0]; };
    pc.current = p;
    return p;
  }
  async function getMedia(video) {
    stream.current = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    return stream.current;
  }
  async function startCall(video) {
    try {
      const s = await getMedia(video);
      setCall({ peer, status: "calling", video });
      const p = newPC(peer);
      s.getTracks().forEach((t) => p.addTrack(t, s));
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      socket.emit("call-offer", { to: peer, offer, video });
    } catch (e) { alert("Cannot access mic/camera: " + e.message); }
  }
  async function acceptCall() {
    try {
      const s = await getMedia(call.video);
      const p = newPC(call.peer);
      s.getTracks().forEach((t) => p.addTrack(t, s));
      await p.setRemoteDescription(call.offer);
      await flushIce();
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      socket.emit("call-answer", { to: call.peer, answer });
      setCall({ ...call, status: "active" });
    } catch (e) { alert("Cannot access mic/camera: " + e.message); endCall(true); }
  }
  function endCall(notify = true) {
    setCall((c) => {
      if (notify && c) socket.emit("call-end", { to: c.peer });
      return null;
    });
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    pc.current?.close();
    pc.current = null;
    pending.current = [];
  }

  // ---------- screens ----------
  if (!me)
    return (
      <div className="login">
        <h1>💬 ChatApp</h1>
        <input placeholder="Choose a username" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} />
        <button onClick={login}>Start</button>
      </div>
    );

  return (
    <div className={"app" + (peer ? " chat-open" : "")}>
      <aside className="sidebar">
        <header><b>{me}</b><button onClick={logout}>Logout</button></header>
        {users.length === 0 && <p className="empty">Open the site in another browser and log in with a different name.</p>}
        {users.map((u) => (
          <div key={u._id} className={"user" + (peer === u.username ? " active" : "")} onClick={() => setPeer(u.username)}>
            <div className="avatar">{u.username[0].toUpperCase()}</div>
            <span>{u.username}</span>
            {online.includes(u.username) && <i className="dot" />}
          </div>
        ))}
      </aside>

      <main className="chat">
        {!peer ? <div className="placeholder">Select a user to start chatting</div> : (
          <>
            <header>
              <button className="back" onClick={() => setPeer(null)}>←</button>
              <b>{peer}</b>
              <span className="status">{online.includes(peer) ? "online" : "offline"}</span>
              <div className="actions">
                <button onClick={() => startCall(false)} title="Voice call">📞</button>
                <button onClick={() => startCall(true)} title="Video call">🎥</button>
              </div>
            </header>
            <div className="messages">
              {msgs.map((m) => (
                <div key={m._id} className={"bubble " + (m.from === me ? "me" : "them")}>
                  {m.text}
                  <small>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <footer>
              <input placeholder="Type a message" value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()} />
              <button onClick={send}>➤</button>
            </footer>
          </>
        )}
      </main>

      {call && (
        <div className="call">
          <h2>{call.peer}</h2>
          <p>{call.status === "calling" ? "Calling…" : call.status === "incoming" ? `Incoming ${call.video ? "video" : "voice"} call` : "Connected"}</p>
          <div className="videos">
            <video ref={remoteV} autoPlay playsInline className="remote" />
            <video ref={localV} autoPlay playsInline muted className="local" />
          </div>
          <div className="call-btns">
            {call.status === "incoming" && <button className="accept" onClick={acceptCall}>Accept</button>}
            <button className="end" onClick={() => endCall(true)}>{call.status === "incoming" ? "Reject" : "End"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
