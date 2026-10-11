import { TYPING_FRAME } from "./burst";

/**
 * A bare test client for `/ws`: each Enter sends one bubble, and typing sends
 * `TYPING_FRAME` at most once a second.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NCR floor</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; }
  #log { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
  .bubble { padding: .35rem .7rem; border-radius: 1rem; max-width: 80%; white-space: pre-wrap; }
  .user { align-self: flex-end; background: #2563eb; color: #fff; }
  .assistant { align-self: flex-start; background: #e5e7eb; }
  #status { color: #6b7280; font-size: 13px; min-height: 1.2em; }
  input { box-sizing: border-box; width: 100%; font: inherit; padding: .5rem; }
</style>
<div id="log"></div>
<div id="status"></div>
<input id="box" placeholder="Type a message, Enter to send" autofocus>
<script>
  const log = document.getElementById("log");
  const status = document.getElementById("status");
  const box = document.getElementById("box");
  const bubble = (role, text) => {
    const el = document.createElement("div");
    el.className = "bubble " + role;
    el.textContent = text;
    log.append(el);
    return el;
  };
  let live;
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.type === "history") for (const b of m.messages) bubble(b.role, b.text);
    if (m.type === "buffered") status.textContent = "holding " + m.count + " message(s) for one turn";
    if (m.type === "steered") status.textContent = "sent to the running reply as a steer";
    if (m.type === "typing") status.textContent = "typing...";
    if (m.type === "delta") (live ??= bubble("assistant", "")).textContent += m.text;
    if (m.type === "reply") { (live ??= bubble("assistant", "")).textContent = m.text; live = undefined; }
    if (m.type === "idle") status.textContent = "";
    if (m.type === "error") status.textContent = "error: " + m.message;
  };
  ws.onclose = () => { status.textContent = "disconnected, reload to reconnect"; };
  let lastTyping = 0;
  box.oninput = () => {
    if (box.value.trim() === "" || Date.now() - lastTyping < 1000) return;
    lastTyping = Date.now();
    ws.send(${JSON.stringify(TYPING_FRAME)});
  };
  box.onkeydown = (e) => {
    if (e.key !== "Enter" || box.value.trim() === "") return;
    bubble("user", box.value);
    ws.send(box.value);
    box.value = "";
    lastTyping = 0;
  };
</script>
</html>
`;
