import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { uptime } from "node:os";

export type OwnedChildMetrics = {
  identity: number | bigint;
  startedAt: number | null;
  cpuSeconds: number | null;
  workingSetKiB: number | null;
  privateKiB: number | null;
};

export type OwnedChildProbe = (pid: number, signal: AbortSignal) => Promise<OwnedChildMetrics | null>;

const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const WAIT_TIMEOUT = 258;

type NativeProc = { unload(): void; func(signature: string): unknown };
type NativeLoader = { load(library: string): NativeProc; sizeof(type: string): number };
type AsyncNative<Args extends unknown[], Result> = {
  async(...args: [...Args, (error: Error | null, result: Result) => void]): void;
};

function nativeAsync<Args extends unknown[], Result>(binding: unknown): (...args: Args) => Promise<Result> {
  const fn = binding as AsyncNative<Args, Result>;
  return (...args) => new Promise((resolve, reject) => {
    fn.async(...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

function bindWindowsProbe(): OwnedChildProbe {
  // Voice already ships this pinned native binding. Resolve from its package
  // so both pnpm's private dependencies and the packaged app layout work.
  const koffi = createRequire(import.meta.resolve("transcribe-cpp"))("koffi") as NativeLoader;
  const kernel32 = koffi.load("kernel32.dll"); // Windows KnownDLL.
  try {
    type Handle = bigint;
    const openProcess = nativeAsync<[number, number, number], Handle | null>(
      kernel32.func("void * __stdcall OpenProcess(uint32_t, int32_t, uint32_t)"),
    );
    const getProcessTimes = nativeAsync<[Handle, Buffer, Buffer, Buffer, Buffer], number>(
      kernel32.func("int32_t __stdcall GetProcessTimes(void *, void *, void *, void *, void *)"),
    );
    const getMemory = nativeAsync<[Handle, Buffer, number], number>(
      kernel32.func("int32_t __stdcall K32GetProcessMemoryInfo(void *, void *, uint32_t)"),
    );
    const waitForExit = kernel32.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)") as
      (handle: Handle, milliseconds: number) => number;
    const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *)") as (handle: Handle) => number;
    const sizeT = koffi.sizeof("size_t");
    if (sizeT !== 4 && sizeT !== 8) throw new Error("Unexpected Windows size_t width");
    const readSize = (data: Buffer, offset: number): number =>
      sizeT === 8 ? Number(data.readBigUInt64LE(offset)) : data.readUInt32LE(offset);

    return async (pid, signal) => {
      if (signal.aborted) return null;
      const handle = await openProcess(QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
      if (!handle) return null;
      try {
        if (signal.aborted) return null;
        const creation = Buffer.alloc(8);
        const kernel = Buffer.alloc(8);
        const user = Buffer.alloc(8);
        if (!await getProcessTimes(handle, creation, Buffer.alloc(8), kernel, user) || signal.aborted) return null;
        const created = creation.readBigUInt64LE();
        if (created < FILETIME_UNIX_EPOCH) return null;
        // PROCESS_MEMORY_COUNTERS_EX: two DWORDs followed by nine SIZE_Ts.
        const memory = Buffer.alloc(8 + 9 * sizeT);
        memory.writeUInt32LE(memory.length);
        const haveMemory = await getMemory(handle, memory, memory.length);
        if (signal.aborted || waitForExit(handle, 0) !== WAIT_TIMEOUT) return null;
        return {
          identity: created,
          startedAt: Number((created - FILETIME_UNIX_EPOCH) / 10_000n),
          cpuSeconds: Number(kernel.readBigUInt64LE() + user.readBigUInt64LE()) / 10_000_000,
          workingSetKiB: haveMemory ? Math.floor(readSize(memory, 8 + sizeT) / 1024) : null,
          privateKiB: haveMemory ? Math.floor(readSize(memory, 8 + 8 * sizeT) / 1024) : null,
        };
      } finally {
        closeHandle(handle);
      }
    };
  } catch (error) {
    kernel32.unload();
    throw error;
  }
}

function goneOrDenied(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH" || error.code === "EACCES" || error.code === "EPERM" || error.code === "ABORT_ERR");
}

export function parseLinuxChildStat(stat: string, parentPid: number) {
  // comm can contain whitespace and parentheses. The other fields cannot.
  const end = stat.lastIndexOf(") ");
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (Number(fields[1]) !== parentPid || fields[0] === "Z" || fields[0] === "X") return null;
  const startTicks = Number(fields[19]);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  if (!Number.isSafeInteger(startTicks) || startTicks < 0 || !Number.isSafeInteger(cpuTicks) || cpuTicks < 0) return null;
  return { startTicks, cpuTicks };
}

let linuxBootEpoch: number | undefined;
const readLinuxChild: OwnedChildProbe = async (pid, signal) => {
  if (signal.aborted) return null;
  try {
    const dir = await open(`/proc/${pid}`, constants.O_DIRECTORY);
    try {
      // A directory descriptor pins the procfs identity even if this PID exits
      // or is reused between the two reads.
      const from = `/proc/self/fd/${dir.fd}`;
      const stat = parseLinuxChildStat(await readFile(`${from}/stat`, { encoding: "utf8", signal }), process.pid);
      if (!stat) return null;
      const status = await readFile(`${from}/status`, { encoding: "utf8", signal });
      const rss = /^VmRSS:[\t ]+(\d+)[\t ]+kB$/m.exec(status);
      // The supported Linux x64/arm64 kernels expose /proc stat in 100 USER_HZ.
      const ticksPerSecond = process.arch === "x64" || process.arch === "arm64" ? 100 : null;
      linuxBootEpoch ??= Date.now() - uptime() * 1000;
      return {
        identity: stat.startTicks,
        startedAt: ticksPerSecond ? Math.round(linuxBootEpoch + stat.startTicks * 1000 / ticksPerSecond) : null,
        cpuSeconds: ticksPerSecond ? stat.cpuTicks / ticksPerSecond : null,
        workingSetKiB: rss ? Number(rss[1]) : null,
        privateKiB: null,
      };
    } finally {
      await dir.close();
    }
  } catch (error) {
    if (goneOrDenied(error)) return null;
    throw error;
  }
};

let windowsProbe: OwnedChildProbe | null | undefined;

/** Only called for the two known local sidecar PIDs, never an enumerated OS process. */
export const readOwnedChildMetrics: OwnedChildProbe = async (pid, signal) => {
  if (process.platform === "linux") return readLinuxChild(pid, signal);
  if (process.platform !== "win32") return null;
  if (windowsProbe === undefined) {
    windowsProbe = null; // A missing native binding should not be reloaded every sample.
    windowsProbe = bindWindowsProbe();
  }
  return windowsProbe ? windowsProbe(pid, signal) : null;
};