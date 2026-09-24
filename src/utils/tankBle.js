// src/utils/tankBle.js
//
// BLE provisioning client for the water-tank device (ESP32-C3 firmware).
// ALL Bluetooth code lives in this one file, so if the app is later wrapped
// in Capacitor (or moved to native), only this file is swapped for a
// @capacitor-community/bluetooth-le implementation - the modal and panel
// don't change. Current implementation: Web Bluetooth (Chrome on
// Android / desktop Chrome, https only). iOS Safari has NO Web Bluetooth.
//
// GATT contract (must match firmware/include/config.h):
//   INFO   (read)              {"id":"TANK-A7F3","fw":"0.1.0"}
//   SCAN   (write+notify)      write "SCAN" -> notifies {"s","r","e"} per network, then {"done":true}
//   PROV   (write, paired)     {"ssid","pass","token"}
//   STATUS (read+notify)       {"state":"connecting|connected|failed","ip","reason"}
//
// Wi-Fi scanning is done by the ESP32 (not the phone) and only SSIDs come
// back. The password is typed by the user and sent over the paired
// (encrypted) link; it is never logged or stored by the app.

export const TANK_SERVICE_UUID = '7a1c0001-5b3e-4f5a-9c1d-2f6b8a4e0001';
const CHAR_INFO = '7a1c0002-5b3e-4f5a-9c1d-2f6b8a4e0001';
const CHAR_SCAN = '7a1c0003-5b3e-4f5a-9c1d-2f6b8a4e0001';
const CHAR_PROV = '7a1c0004-5b3e-4f5a-9c1d-2f6b8a4e0001';
const CHAR_STATUS = '7a1c0005-5b3e-4f5a-9c1d-2f6b8a4e0001';

const SCAN_TIMEOUT_MS = 15000;
const PROVISION_TIMEOUT_MS = 40000; // firmware waits up to 20s for Wi-Fi

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class TankBleError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function isTankBleSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

const write = (characteristic, bytes) =>
  characteristic.writeValueWithResponse
    ? characteristic.writeValueWithResponse(bytes)
    : characteristic.writeValue(bytes);

const parseNotification = (event) => {
  try {
    return JSON.parse(decoder.decode(event.target.value));
  } catch {
    return null;
  }
};

/**
 * Opens the browser's device chooser (filtered to tank devices), connects,
 * and forces OS-level pairing. Resolves to a session object.
 * Throws TankBleError; code 'cancelled' means the user closed the chooser.
 */
export async function connectToTank({ onDisconnect } = {}) {
  if (!isTankBleSupported()) {
    throw new TankBleError('unsupported', 'Bluetooth setup is not available in this browser.');
  }

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [TANK_SERVICE_UUID] }],
    });
  } catch (e) {
    if (e?.name === 'NotFoundError') throw new TankBleError('cancelled', 'No device selected.');
    throw new TankBleError('connect_failed', e?.message);
  }

  if (onDisconnect) device.addEventListener('gattserverdisconnected', onDisconnect);

  try {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(TANK_SERVICE_UUID);
    // Fetched sequentially: more reliable than Promise.all on some Android stacks.
    const infoCh = await service.getCharacteristic(CHAR_INFO);
    const scanCh = await service.getCharacteristic(CHAR_SCAN);
    const provCh = await service.getCharacteristic(CHAR_PROV);
    const statusCh = await service.getCharacteristic(CHAR_STATUS);

    let deviceId = device.name || null;
    try {
      const info = JSON.parse(decoder.decode(await infoCh.readValue()));
      if (info?.id) deviceId = info.id;
    } catch {
      /* fall back to advertised name */
    }
    if (!deviceId) throw new TankBleError('connect_failed', 'Could not read the device ID.');

    // STATUS is an encrypted+authenticated read on the firmware side, so this
    // read makes the phone start pairing (OS shows the 6-digit PIN prompt).
    try {
      await statusCh.readValue();
    } catch (e) {
      throw new TankBleError('pairing_failed', e?.message);
    }

    return {
      deviceId,

      /** Asks the ESP32 to scan Wi-Fi; resolves to [{ ssid, rssi, secure }]. */
      scanWifi() {
        return new Promise((resolve, reject) => {
          const networks = [];
          let timer;
          const cleanup = () => {
            clearTimeout(timer);
            scanCh.removeEventListener('characteristicvaluechanged', handler);
          };
          const finish = () => {
            cleanup();
            resolve(networks.sort((a, b) => b.rssi - a.rssi));
          };
          const handler = (event) => {
            const msg = parseNotification(event);
            if (!msg) return;
            if (msg.done) return finish();
            if (msg.s) networks.push({ ssid: msg.s, rssi: msg.r ?? -100, secure: !!msg.e });
          };

          timer = setTimeout(() => {
            if (networks.length) return finish();
            cleanup();
            reject(new TankBleError('scan_timeout', 'No response to the Wi-Fi scan.'));
          }, SCAN_TIMEOUT_MS);

          scanCh
            .startNotifications()
            .then(() => {
              scanCh.addEventListener('characteristicvaluechanged', handler);
              return write(scanCh, encoder.encode('SCAN'));
            })
            .catch((e) => {
              cleanup();
              reject(new TankBleError('write_failed', e?.message));
            });
        });
      },

      /**
       * Sends Wi-Fi credentials + device token, then waits for the device to
       * report "connected" (resolves { ip }) or "failed" (rejects with
       * code = firmware reason: auth_failed | ssid_not_found | timeout | ...).
       */
      provision({ ssid, password, token }) {
        return new Promise((resolve, reject) => {
          let timer;
          const cleanup = () => {
            clearTimeout(timer);
            statusCh.removeEventListener('characteristicvaluechanged', handler);
          };
          const handler = (event) => {
            const msg = parseNotification(event);
            if (!msg) return;
            if (msg.state === 'connected') {
              cleanup();
              resolve({ ip: msg.ip });
            } else if (msg.state === 'failed') {
              cleanup();
              reject(new TankBleError(msg.reason || 'failed', 'Device could not join Wi-Fi.'));
            }
          };

          timer = setTimeout(() => {
            cleanup();
            reject(new TankBleError('provision_timeout', 'Device did not answer in time.'));
          }, PROVISION_TIMEOUT_MS);

          statusCh
            .startNotifications()
            .then(() => {
              statusCh.addEventListener('characteristicvaluechanged', handler);
              const payload = encoder.encode(JSON.stringify({ ssid, pass: password, token }));
              return write(provCh, payload);
            })
            .catch((e) => {
              cleanup();
              reject(new TankBleError('write_failed', e?.message));
            });
        });
      },

      disconnect() {
        try {
          if (device.gatt?.connected) device.gatt.disconnect();
        } catch {
          /* already gone */
        }
      },
    };
  } catch (e) {
    try {
      if (device.gatt?.connected) device.gatt.disconnect();
    } catch {
      /* ignore */
    }
    if (e instanceof TankBleError) throw e;
    throw new TankBleError('connect_failed', e?.message);
  }
}