import { ipcRenderer } from "electron";

import { installBrowserIdentity } from "./preview/BrowserIdentity.ts";
import { PASSKEY_BRIDGE_ARGUMENT } from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import "./preview/PickPreload.ts";

// Preview guests use contextIsolation:false, so the page sees these before its scripts run.
installBrowserIdentity(location.href, navigator);

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}
