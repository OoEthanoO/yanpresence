import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Windows PowerShell, not PowerShell 7.
 *
 * Everything Windows-specific here goes through it: the media session watcher
 * projects WinRT types out of the runtime, and the tray icon builds a WinForms
 * NotifyIcon. Only Windows PowerShell can do the first -- pwsh needs the
 * CsWinRT projections from the Windows SDK, which are not on a stock machine.
 * 5.1 ships with Windows and is at a fixed path, so this needs nothing
 * installed and does not depend on PATH.
 */
export const POWERSHELL =
  process.env.YANPRESENCE_POWERSHELL ||
  path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

/** The flags every one of our PowerShell invocations wants. */
export function psArgs(script, ...rest) {
  return [
    '-NoProfile',
    '-NonInteractive',
    // Our scripts are unsigned and live in the checkout. Bypassing here (rather
    // than asking the user to change machine policy) keeps them runnable on a
    // default install, and applies to this process only.
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    ...rest,
  ];
}

export function runPowerShell(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().split('\n')[0];
          const error = new Error(detail || 'powershell failed');
          error.code = err.code;
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

const VENDOR_IDS = [
  [/ven_1002|advanced micro devices|\bamd\b|radeon/i, 'amd'],
  [/ven_10de|nvidia|geforce/i, 'nvidia'],
  [/ven_8086|\bintel\b/i, 'intel'],
];

/**
 * The display adapters in this machine, in the shape gpu.js reasons about.
 *
 * The Linux side reads /sys/class/drm; Windows has no equivalent file to read,
 * so this asks WMI. Which vendor is present is the whole question: AMF is
 * AMD's own SDK and enumerates only AMD devices, so "is there an AMD adapter"
 * decides whether the AV1 encode can go to the GPU -- and on a laptop with a
 * discrete NVIDIA card as well, it is the only way to know the iGPU is there
 * at all.
 */
export async function detectWindowsAdapters() {
  if (process.platform !== 'win32') return [];

  let out;
  try {
    out = await runPowerShell(
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | ' +
          'Select-Object Name, AdapterCompatibility, PNPDeviceID | ' +
          'ConvertTo-Json -Compress',
      ],
      { timeoutMs: 10000 }
    );
  } catch {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(out.trim() || 'null');
  } catch {
    return [];
  }
  if (!parsed) return [];

  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
    const haystack = `${entry.PNPDeviceID ?? ''} ${entry.AdapterCompatibility ?? ''} ${entry.Name ?? ''}`;
    const vendor = VENDOR_IDS.find(([re]) => re.test(haystack))?.[1] ?? 'unknown';
    return { node: String(entry.Name ?? 'display adapter'), vendor, name: String(entry.Name ?? '') };
  });
}
