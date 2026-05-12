import * as vscode from 'vscode';
import { Snapshot, BalanceStats } from './types';

const STORAGE_KEY = 'deepseek-balance.snapshots';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class HistoryStore {
  constructor(private ctx: vscode.ExtensionContext) {}

  addSnapshot(snapshot: Snapshot): void {
    const snapshots = this.getAll();
    // Only add if balance changed or it's the first snapshot
    if (
      snapshots.length > 0 &&
      snapshots[snapshots.length - 1].totalBalance === snapshot.totalBalance &&
      snapshots[snapshots.length - 1].currency === snapshot.currency
    ) {
      return;
    }
    snapshots.push(snapshot);
    this.cleanup(snapshots);
    this.ctx.globalState.update(STORAGE_KEY, snapshots);
  }

  getAll(): Snapshot[] {
    return this.ctx.globalState.get<Snapshot[]>(STORAGE_KEY, []);
  }

  getSince(sinceMs: number): Snapshot[] {
    const cutoff = Date.now() - sinceMs;
    return this.getAll().filter((s) => s.timestamp >= cutoff);
  }

  getStats(): BalanceStats {
    const now = Date.now();
    const snapshots = this.getAll();

    const last1h = this.computeDelta(snapshots, now - 60 * 60 * 1000);
    const last24h = this.computeDelta(snapshots, now - 24 * 60 * 60 * 1000);
    const last7d = this.computeDelta(snapshots, now - 7 * 24 * 60 * 60 * 1000);

    // total consumed = earliest balance - latest balance
    let totalConsumed = 0;
    if (snapshots.length >= 2) {
      const earliest = parseFloat(snapshots[0].totalBalance);
      const latest = parseFloat(snapshots[snapshots.length - 1].totalBalance);
      totalConsumed = Math.max(0, earliest - latest);
    }

    return { last1h, last24h, last7d, totalConsumed };
  }

  private computeDelta(snapshots: Snapshot[], since: number): number {
    const filtered = snapshots.filter((s) => s.timestamp >= since);
    if (filtered.length < 2) {return 0;}
    const first = parseFloat(filtered[0].totalBalance);
    const last = parseFloat(filtered[filtered.length - 1].totalBalance);
    return Math.max(0, first - last);
  }

  private cleanup(snapshots: Snapshot[]): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    let idx = 0;
    while (idx < snapshots.length && snapshots[idx].timestamp < cutoff) {
      idx++;
    }
    if (idx > 0) {
      snapshots.splice(0, idx);
    }
  }
}
