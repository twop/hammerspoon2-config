// Active-process explorer, driven by hs.chooser and themed to match the
// other pickers. Port of process-explorer.lua. Nothing here is cached
// across show() calls. v2 has no synchronous hs.execute, so parsing `ps`
// is async (hs.task.shell()); everything downstream (rootPids, the
// chooser levels) stays synchronous once that one await resolves.

import { Theme, chooserColor } from "./nord-theme";

interface ProcRecord {
  pid: number;
  ppid: number;
  cpu: number | null;
  memMB: number | null;
  comm: string;
  children: number[];
}

// macOS's `ps` never reports pid 0 (kernel_task), so it's synthesized
// after parsing to anchor the true root of the tree. Its one real child,
// pid 1, already ends up in childrenOf.get(0) from the normal parse.
async function parseProcesses(): Promise<Map<number, ProcRecord>> {
  const { stdout } = await hs.task.shell("ps -axo pid,ppid,pcpu,rss,comm", {});

  const byPid = new Map<number, ProcRecord>();
  const childrenOf = new Map<number, number[]>();

  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    byPid.set(pid, {
      pid,
      ppid,
      cpu: Number(m[3]),
      memMB: Number(m[4]) / 1024,
      comm: m[5]!,
      children: [],
    });
    const kids = childrenOf.get(ppid) ?? [];
    kids.push(pid);
    childrenOf.set(ppid, kids);
  }

  for (const [ppid, kids] of childrenOf) {
    const rec = byPid.get(ppid);
    if (rec) rec.children = kids;
  }

  byPid.set(0, { pid: 0, ppid: -1, cpu: null, memMB: null, comm: "kernel_task", children: childrenOf.get(0) ?? [] });
  return byPid;
}

function rootPids(byPid: Map<number, ProcRecord>): number[] {
  return [0, 1, ...(byPid.get(1)?.children ?? [])];
}

// Resolves the .app bundle a process belongs to, if any: first via the
// pid's own running-application entry, falling back to the outermost
// .app segment in its executable path (covers helper/XPC processes that
// live inside an app bundle but never register as a running application
// of their own).
function iconForPid(pid: number, comm: string): HSImage | null {
  const app = hs.application.fromPID(pid);
  const bundlePath = app?.bundlePath ?? comm.match(/^(.*?\.app)\//)?.[1];
  return bundlePath ? HSImage.iconForFile(bundlePath) : null;
}

function processRow(record: ProcRecord): Record<string, unknown> {
  return {
    text: record.comm.match(/([^/]+)$/)?.[1] ?? record.comm,
    subText:
      `PID ${record.pid} · ${record.cpu !== null ? record.cpu.toFixed(1) + "% CPU" : "— CPU"} · ` +
      `${record.memMB !== null ? Math.round(record.memMB) + " MB" : "— MB"} · ${record.children.length} children`,
    image: iconForPid(record.pid, record.comm),
    pid: record.pid,
  };
}

function hammerspoonOwnPid(): number {
  return hs.appinfo.pid;
}

async function killProcess(pid: number, signal: "TERM" | "KILL"): Promise<void> {
  if (pid === 0 || pid === 1 || pid === hammerspoonOwnPid()) {
    hs.ui.alert(`Refusing to kill pid ${pid}`).show();
    return;
  }
  await hs.task.shell(`kill ${signal === "KILL" ? "-KILL" : "-TERM"} ${pid}`, {});
}

function styleChooser(c: HSChooser): void {
  c.width = 0.35;
  c.backgroundColor = chooserColor(Theme.background);
  c.borderColor = chooserColor(Theme.border);
  c.cornerRadius = Theme.cornerRadius;
  c.textColor = chooserColor(Theme.text);
  c.subTextColor = chooserColor(Theme.textDim);
}

function showLevelChooser(pids: number[], byPid: Map<number, ProcRecord>): void {
  const records = pids.map((pid) => byPid.get(pid)).filter((r): r is ProcRecord => r !== undefined);
  records.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));

  const c = hs.chooser.create();
  styleChooser(c);
  c.visibleRows = 9;
  c.searchSubText = true;
  c.placeholder = "Browse processes…";
  c.setChoices(records.map(processRow));
  c.onSelect = (choice) => {
    if (!choice) return;
    const record = byPid.get(choice["pid"] as number);
    if (record) showActionsChooser(record, byPid);
  };
  c.show();
}

function showActionsChooser(record: ProcRecord, byPid: Map<number, ProcRecord>): void {
  const name = record.comm.match(/([^/]+)$/)?.[1] ?? record.comm;
  const choices: Record<string, unknown>[] = [
    { text: "Kill (SIGTERM)", subText: `Ask ${name} (pid ${record.pid}) to quit`, kind: "term" },
    { text: "Force Kill (SIGKILL)", subText: `Immediately terminate ${name} (pid ${record.pid})`, kind: "kill" },
  ];
  if (record.children.length > 0) {
    choices.push({ text: `View ${record.children.length} children →`, subText: name, kind: "children" });
  }

  const c = hs.chooser.create();
  styleChooser(c);
  c.visibleRows = Math.min(choices.length, 9);
  c.placeholder = name;
  c.setChoices(choices);
  c.onSelect = (choice) => {
    if (!choice) return;
    if (choice["kind"] === "term") void killProcess(record.pid, "TERM");
    else if (choice["kind"] === "kill") void killProcess(record.pid, "KILL");
    else if (choice["kind"] === "children") showLevelChooser(record.children, byPid);
  };
  c.show();
}

export async function show(): Promise<void> {
  const byPid = await parseProcesses();
  showLevelChooser(rootPids(byPid), byPid);
}
