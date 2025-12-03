"use strict";

const fs = require("fs");
const path = require("path");
const {ipcRenderer} = require("electron");
const log = require("./log");
const stringify = require("./stringify");
const {translate} = require("./translate");
const {parse_version, compare_versions} = require("./utils");
const {new_query, compare_queries} = require("./query");

const bad_versions = [
  [1, 9, 0],
];

function new_engine(...args) {
  return new Engine(...args);
}

class Engine {
  constructor() {
    this.is_gtp = false;
    this.has_quit = false;

    this.received_version = false;
    this.version = [1, 0, 0];
    this.tuning_in_progress = false;

    this.filepath = "";
    this.engineconfig = "";
    this.weights = "";

    this.desired = null;
    this.running = null;

    this._ws = null;
    this._connected = false;
    this._pending_queue = [];

    this._ws_url = "ws://127.0.0.1:41949";
  }

  __send(o) {
    if (!o || typeof o !== "object") {
      throw new Error("__send(): requires an object");
    }

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      this._pending_queue.push(o);
      if (config && config.logfile) this.log_sent_object(o);
      return;
    }

    try {
      const msg = JSON.stringify(o);
      this._ws.send(msg);
      if (config && config.logfile) this.log_sent_object(o);
    } catch (err) {
      this.log_and_alert("While sending to engine:", err.toString());
      this.shutdown();
    }
  }

  analyse(node, maxvisits = null, avoid_list = null) {
    if (!this._connected) return;

    const query = new_query(node, this.version, maxvisits, avoid_list);

    if (this.desired && compare_queries(this.desired, query)) return;

    this.desired = query;

    if (this.running) {
      this.__send({
        id: `stop!${this.running.id}`,
        action: "terminate",
        terminateId: `${this.running.id}`
      });
    } else {
      this.__send(this.desired);
      this.running = this.desired;
    }
  }

  halt() {
    this.desired = null;
    if (this.running) {
      this.__send({
        id: `stop!${this.running.id}`,
        action: "terminate",
        terminateId: `${this.running.id}`
      });
    }
  }

  setup(filepath, engineconfig, weights) {
    if (this._ws || this.has_quit) {
      throw new Error("setup(): engine object should not be reused");
    }

    this.filepath     = fs.existsSync(filepath)     ? filepath     : "";
    this.engineconfig = fs.existsSync(engineconfig) ? engineconfig : "";
    this.weights      = fs.existsSync(weights)      ? weights      : "";

    if (!this.filepath || !this.engineconfig || !this.weights) return;

    if (process.env.KATAGO_WS_PROXY_URL) {
      this._ws_url = process.env.KATAGO_WS_PROXY_URL;
    }

    this._connect_ws();
  }

  _connect_ws() {
    log("");
    log("-----------------------------------------------------------------------------------");
    log(`KataGo via proxy at ${this._ws_url}`);

    this._ws = new WebSocket(this._ws_url);

    this._ws.onopen = () => {
      this._connected = true;

      while (this._pending_queue.length > 0) {
        this.__send(this._pending_queue.shift());
      }

      this.__send({id: "query_version", action: "query_version"});
      this.__send({
        id: "test_bs29",
        rules: "Chinese",
        boardXSize: 29,
        boardYSize: 29,
        maxVisits: 1,
        moves: []
      });
    };

    this._ws.onclose = () => {
      if (!this.has_quit) {
        this.log_and_alert("The engine proxy connection appears to have closed.");
        this.shutdown();
      }
    };

    this._ws.onerror = (err) => {
      this.log_and_alert("Got ws error:", err.toString());
      this.shutdown();
    };

    this._ws.onmessage = (ev) => {
      if (this.has_quit) return;

      let o;
      try {
        o = JSON.parse(ev.data);
        if (config && config.logfile) this.log_received_object(o);
      } catch {
        this.log_and_alert("Received non-JSON:", ev.data);
        return;
      }

      if (o.id === "test_bs29") {
        if (!o.error) {
          this.log_and_alert(
            "This build of KataGo appears to be compiled with \"bs29\" support. It will be significantly slower."
          );
        }
        return;
      }

      if (o.error) alert("Engine said:\n" + stringify(o));
      if (o.warning) console.log("Engine warning:", o.warning);

      if (o.action === "query_version" && o.version) {
        this.version = parse_version(o.version);
        this.received_version = true;

        for (let bv of bad_versions) {
          if (compare_versions(bv, this.version) === 0) {
            alert(`This exact version of KataGo (${o.version}) is known to crash under Ogatak.`);
          }
        }
      }

      let finished = false;

      if (o.action === "terminate") {
        if (this.running && this.running.id === o.terminateId) finished = true;
      }

      if (o.error && this.running && this.running.id === o.id) finished = true;

      if (finished) {
        if (this.desired === this.running) this.desired = null;
        this.running = null;

        if (this.desired) {
          this.__send(this.desired);
          this.running = this.desired;
        }
      }

      try {
        hub.receive_object(o);
      } catch (e) {
        console.error("hub.receive_object error:", e);
      }
    };
  }

  log_received_object(o) {
    const redacted = {};
    for (const [k, v] of Object.entries(o)) {
      redacted[k] = ["moveInfos", "ownership", "policy"].includes(k) ? ["redacted"] : v;
    }
    log("< " + JSON.stringify(redacted));
  }

  log_sent_object(o) {
    const redacted = {};
    for (const [k, v] of Object.entries(o)) {
      redacted[k] = k === "moves" ? ["redacted"] : v;
    }
    log("\n--> " + JSON.stringify(redacted) + "\n");
  }

  log_and_alert(...args) {
    log(args.join(" "));
    console.log(args.join(" "));
    alert(args.join("\n"));
  }

  problem_text() {
    if (this._connected) return "";
    if (!this.filepath) return translate("GUI_ENGINE_NOT_SET");
    if (!this.engineconfig) return translate("GUI_ENGINE_CONFIG_NOT_SET");
    if (!this.weights) return translate("GUI_WEIGHTS_NOT_SET");
    return `Engine (${path.basename(this.filepath)}) not running.`;
  }

  shutdown() {
    this.has_quit = true;

    try {
      if (this._ws) this._ws.close();
    } catch {}

    this._ws = null;
    this._connected = false;
    this._pending_queue = [];
    this.running = null;
    this.desired = null;
  }
}

module.exports = new_engine;


