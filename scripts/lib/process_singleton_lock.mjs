import fs from "node:fs/promises";
import path from "node:path";

async function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockFile(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function acquireProcessSingletonLock(
  lockPath,
  {
    ownerPid = process.pid,
    ownerLabel = "process",
    isPidAlive = defaultIsPidAlive,
  } = {},
) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: ownerPid,
            label: ownerLabel,
            acquired_at: new Date().toISOString(),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );

      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        const current = await readLockFile(lockPath);
        if (current?.pid === ownerPid) {
          await fs.rm(lockPath, { force: true });
        }
      };

      return {
        acquired: true,
        ownerPid,
        release,
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const current = await readLockFile(lockPath);
      const currentPid = Number.parseInt(String(current?.pid ?? ""), 10);

      if (Number.isFinite(currentPid) && currentPid > 0 && currentPid !== ownerPid) {
        if (await isPidAlive(currentPid)) {
          return {
            acquired: false,
            ownerPid,
            existingPid: currentPid,
            existingLabel: current?.label ?? null,
          };
        }
      }

      await fs.rm(lockPath, { force: true });
    }
  }
}
