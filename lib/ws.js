"use strict";

/**
 * Tiny dependency-free WebSocket server (RFC 6455) used by Prism for the live
 * browser engine stream and for tunnelling upstream websockets.
 *
 * Node ships a WebSocket *client* but no server, and Prism deliberately has no
 * runtime dependencies, so we implement the small subset we need: text frames,
 * binary frames, continuation, ping/pong and close.
 */

const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.open = true;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = 0;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._closed());
    socket.on("error", () => this._closed());
    if (head && head.length) this._onData(head);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const parsed = this._readFrame();
      if (!parsed) return;
      const { fin, opcode, payload } = parsed;
      if (opcode === OP.CLOSE) {
        this.close(1000);
        return;
      }
      if (opcode === OP.PING) {
        this._writeFrame(OP.PONG, payload);
        continue;
      }
      if (opcode === OP.PONG) continue;
      if (opcode === OP.CONT) {
        this._fragments.push(payload);
      } else {
        this._fragments = [payload];
        this._fragOpcode = opcode;
      }
      if (!fin) continue;
      const full = Buffer.concat(this._fragments);
      this._fragments = [];
      if (this._fragOpcode === OP.TEXT) this.emit("message", full.toString("utf8"), false);
      else this.emit("message", full, true);
    }
  }

  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > 64n * 1024n * 1024n) {
        this.close(1009);
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    }
    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _writeFrame(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(header);
      this.socket.write(payload);
      return true;
    } catch {
      this._closed();
      return false;
    }
  }

  send(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return this._writeFrame(OP.TEXT, Buffer.from(text, "utf8"));
  }

  sendBinary(buf) {
    return this._writeFrame(OP.BINARY, Buffer.from(buf));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._writeFrame(OP.CLOSE, payload);
    this.open = false;
    try {
      this.socket.end();
    } catch {}
    this.emit("close");
  }

  /* convenience: async iterator style message helper */
  onJSON(fn) {
    this.on("message", (data, binary) => {
      if (binary) return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      fn(parsed);
    });
  }
}

/**
 * Handle a raw HTTP upgrade request. `handler(conn, req, url)` is called once
 * the handshake completed. Returns false when the request is not a valid
 * websocket upgrade.
 */
function upgrade(req, socket, head, handler) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.destroy();
    return false;
  }
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  const proto = req.headers["sec-websocket-protocol"];
  if (proto) {
    // echo the first requested subprotocol, which is what browsers expect
    lines.push(`Sec-WebSocket-Protocol: ${String(proto).split(",")[0].trim()}`);
  }
  try {
    socket.write(lines.join("\r\n") + "\r\n\r\n");
  } catch {
    socket.destroy();
    return false;
  }
  const conn = new WsConnection(socket, head);
  handler(conn, req);
  return true;
}

module.exports = { WsConnection, upgrade };
