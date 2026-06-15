"use strict";
const axios = require("axios");
const https = require("https");

// UDM Pro uses a self-signed certificate
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-unifi-alarm", "UnifiAlarm", UnifiAlarmPlatform);
};

class UnifiAlarmPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!api) return;

    api.on("didFinishLaunching", () => {
      const uuid = UUIDGen.generate("unifi-alarm-" + this.config.controller);
      const cached = this.accessories.find(a => a.UUID === uuid);
      const stale = this.accessories.filter(a => a.UUID !== uuid);
      if (stale.length > 0) {
        this.api.unregisterPlatformAccessories("homebridge-unifi-alarm", "UnifiAlarm", stale);
      }
      if (cached) {
        this.log("Restoring UniFi Alarm from cache.");
        new UnifiAlarmAccessory(this.log, this.config, this.api, Service, Characteristic, cached);
      } else {
        const accessory = new this.api.platformAccessory(this.config.name || "Security System", uuid);
        new UnifiAlarmAccessory(this.log, this.config, this.api, Service, Characteristic, accessory);
        this.api.registerPlatformAccessories("homebridge-unifi-alarm", "UnifiAlarm", [accessory]);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class UnifiAlarmAccessory {
  constructor(log, config, api, Service, Characteristic, accessory) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.accessory = accessory;
    this.name = config.name || "Security System";
    this.controller = config.controller;
    this.username = config.username;
    this.password = config.password;

    this.cookies = null;
    this.csrfToken = null;
    this.profileId = config.armProfileId || null;  // auto-discovered if not set
    // UniFi Alarm Manager profile state: "disarmed" | "arming" | "armed" | "breached"
    this.status = "disarmed";

    this.securityService = accessory.getService(Service.SecuritySystem)
      || accessory.addService(Service.SecuritySystem, this.name);
    this.securityService.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState());
    this.securityService.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.targetState())
      .onSet(this.handleTargetStateSet.bind(this));

    if (api) {
      api.on("shutdown", () => {
        if (this.pollInterval) clearInterval(this.pollInterval);
      });
    }

    this.init();
  }

  get alarmsBase() {
    return `https://${this.controller}/api/v2/alarms`;
  }

  get authHeaders() {
    return { Cookie: this.cookies, "X-Csrf-Token": this.csrfToken };
  }

  currentState() {
    const C = this.Characteristic.SecuritySystemCurrentState;
    switch (this.status) {
      case "armed": return C.AWAY_ARM;
      case "breached": return C.ALARM_TRIGGERED;
      // "arming" reports DISARMED so HomeKit shows "Arming…" until it lands.
      case "arming":
      case "disarmed":
      default: return C.DISARMED;
    }
  }

  targetState() {
    const C = this.Characteristic.SecuritySystemTargetState;
    return this.status === "disarmed" ? C.DISARM : C.AWAY_ARM;
  }

  updateStates() {
    this.securityService.updateCharacteristic(
      this.Characteristic.SecuritySystemCurrentState, this.currentState());
    this.securityService.updateCharacteristic(
      this.Characteristic.SecuritySystemTargetState, this.targetState());
  }

  async login() {
    const response = await axios.post(
      `https://${this.controller}/api/auth/login`,
      { username: this.username, password: this.password },
      { httpsAgent, timeout: 15000, headers: { "Content-Type": "application/json" } }
    );
    const setCookies = response.headers["set-cookie"];
    if (setCookies) {
      this.cookies = setCookies.map(c => c.split(";")[0]).join("; ");
    }
    this.csrfToken = response.headers["x-csrf-token"];
    this.log(`[${this.name}] Logged in to UniFi.`);
  }

  // Returns the current state string, auto-discovering the profile on first call.
  async readState() {
    const response = await axios.get(`${this.alarmsBase}/profiles`, {
      httpsAgent, timeout: 15000, headers: this.authHeaders,
    });
    const profiles = response.data || [];
    const profile = this.profileId
      ? profiles.find(p => p.id === this.profileId)
      : profiles[0];
    if (!profile) throw new Error("No alarm profile found");
    if (!this.profileId) {
      this.profileId = profile.id;
      this.log(`[${this.name}] Using arm profile: ${profile.title} (${profile.id})`);
    }
    return profile.state;
  }

  async init() {
    try {
      await this.login();
      this.status = await this.readState();
      this.updateStates();
      this.log(`[${this.name}] State: ${this.status}`);
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log.error(`[${this.name}] Initialization failed: ${detail}`);
      return;
    }

    this.pollInterval = setInterval(() => {
      this.poll().catch(err => {
        this.log.error(`[${this.name}] Poll error: ${err.message}`);
      });
    }, 5 * 1000);
  }

  async poll() {
    try {
      const prev = this.status;
      this.status = await this.readState();
      if (prev !== this.status) {
        this.log(`[${this.name}] State changed: ${this.status}`);
        this.updateStates();
      }
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.log.warn(`[${this.name}] Session expired, re-logging in...`);
        await this.login();
      } else {
        throw err;
      }
    }
  }

  async handleTargetStateSet(value) {
    const C = this.Characteristic.SecuritySystemTargetState;
    const arming = value !== C.DISARM;

    if (!this.profileId) {
      this.log.error(`[${this.name}] No arm profile available.`);
      return;
    }

    try {
      const action = arming ? "arm" : "disarm";
      await axios.post(
        `${this.alarmsBase}/profiles/${this.profileId}/actions/${action}`,
        {},
        { httpsAgent, timeout: 15000, headers: { ...this.authHeaders, "Content-Type": "application/json" } }
      );
      // Optimistic; poll reconciles "arming" -> "armed".
      this.status = arming ? "arming" : "disarmed";
      this.log(`[${this.name}] ${arming ? "Arm command sent." : "Disarmed."}`);
      this.updateStates();
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.log.warn(`[${this.name}] Session expired, re-logging in and retrying...`);
        await this.login();
        return this.handleTargetStateSet(value);
      }
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log.error(`[${this.name}] Command failed: ${detail}`);
    }
  }
}
