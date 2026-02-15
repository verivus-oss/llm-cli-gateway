import { describe, it, expect } from "vitest";
import { parseProcStat, parseVmRss, ProcessMonitor } from "../process-monitor.js";

describe("parseProcStat", () => {
  it("should parse a standard /proc/[pid]/stat line", () => {
    // pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime ...
    const content = "12345 (node) S 1 12345 12345 0 -1 0 100 0 0 0 500 200 0 0 20 0 1 0 10000 1000000 200 18446744073709551615";
    const result = parseProcStat(content);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("S");
    expect(result!.utime).toBe(500);
    expect(result!.stime).toBe(200);
  });

  it("should handle comm field with spaces", () => {
    const content = "12345 (my fancy app) R 1 12345 12345 0 -1 0 100 0 0 0 300 150 0 0 20 0 1 0 10000 1000000 200 18446744073709551615";
    const result = parseProcStat(content);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("R");
    expect(result!.utime).toBe(300);
    expect(result!.stime).toBe(150);
  });

  it("should handle comm field with parentheses", () => {
    const content = "12345 (app (test)) S 1 12345 12345 0 -1 0 100 0 0 0 100 50 0 0 20 0 1 0 10000 1000000 200 18446744073709551615";
    const result = parseProcStat(content);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("S");
    expect(result!.utime).toBe(100);
  });

  it("should return null for malformed input", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("no parentheses here")).toBeNull();
  });

  it("should return null when not enough fields after comm", () => {
    const content = "12345 (node) S 1 2";
    const result = parseProcStat(content);
    expect(result).toBeNull();
  });
});

describe("parseVmRss", () => {
  it("should extract VmRSS from /proc/[pid]/status content", () => {
    const content = [
      "Name:\tnode",
      "State:\tS (sleeping)",
      "Tgid:\t12345",
      "VmPeak:\t 1000000 kB",
      "VmSize:\t  900000 kB",
      "VmRSS:\t   50000 kB",
      "VmData:\t  400000 kB"
    ].join("\n");
    expect(parseVmRss(content)).toBe(50000);
  });

  it("should return null when VmRSS line is missing", () => {
    const content = [
      "Name:\tnode",
      "State:\tS (sleeping)",
      "Tgid:\t12345"
    ].join("\n");
    expect(parseVmRss(content)).toBeNull();
  });

  it("should return null for empty content", () => {
    expect(parseVmRss("")).toBeNull();
  });
});

describe("ProcessMonitor", () => {
  it("should sample own process (alive)", () => {
    const monitor = new ProcessMonitor();
    const health = monitor.sampleProcess(process.pid);
    expect(health.alive).toBe(true);
    expect(health.pid).toBe(process.pid);
    expect(health.sampledAt).toBeTruthy();
    // On Linux, state should be available
    if (process.platform === "linux") {
      expect(health.state).toBeTruthy();
      expect(health.memoryRssKb).toBeGreaterThan(0);
    }
  });

  it("should report dead process for non-existent PID", () => {
    const monitor = new ProcessMonitor();
    // Use a very high PID that's unlikely to exist
    const health = monitor.sampleProcess(4999999);
    expect(health.alive).toBe(false);
    expect(health.state).toBeNull();
    expect(health.cpuPercent).toBeNull();
    expect(health.memoryRssKb).toBeNull();
  });

  it("should compute CPU percent between two samples with delay", async () => {
    if (process.platform !== "linux") return; // Skip on non-Linux
    const monitor = new ProcessMonitor();

    // First sample — establishes baseline
    const first = monitor.sampleProcess(process.pid);
    expect(first.cpuPercent).toBeNull(); // No previous sample

    // Wait a moment to accumulate some jiffies
    await new Promise(r => setTimeout(r, 100));

    // Second sample — should produce a delta (may be 0 if idle, but should be a number)
    const second = monitor.sampleProcess(process.pid);
    // With very short delay, totalJiffiesDelta might be 0, so cpuPercent could be null
    // We only assert that it's either null (no delta) or a valid number
    if (second.cpuPercent !== null) {
      expect(typeof second.cpuPercent).toBe("number");
      expect(second.cpuPercent).toBeGreaterThanOrEqual(0);
    }
  });

  it("should check job health with dead process detection", () => {
    const monitor = new ProcessMonitor();
    const jobs = [{
      jobId: "test-1",
      cli: "claude",
      status: "running",
      pid: 4999999, // Non-existent
      startedAt: new Date().toISOString()
    }];
    const health = monitor.checkJobHealth(jobs);
    expect(health).toHaveLength(1);
    expect(health[0].isDead).toBe(true);
    expect(health[0].isZombie).toBe(false);
  });

  it("should handle jobs with null PID", () => {
    const monitor = new ProcessMonitor();
    const jobs = [{
      jobId: "test-2",
      cli: "codex",
      status: "running",
      pid: null,
      startedAt: new Date().toISOString()
    }];
    const health = monitor.checkJobHealth(jobs);
    expect(health).toHaveLength(1);
    expect(health[0].processHealth).toBeNull();
    expect(health[0].isDead).toBe(false);
  });

  it("should clean up stale samples", () => {
    const monitor = new ProcessMonitor();
    // Create a sample
    monitor.sampleProcess(process.pid);

    // Cleanup with no active PIDs
    monitor.cleanupSamples(new Set());

    // Next sample should have no previous baseline
    const health = monitor.sampleProcess(process.pid);
    expect(health.cpuPercent).toBeNull();
  });

  it("should calculate runningForMs correctly", () => {
    const monitor = new ProcessMonitor();
    const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
    const jobs = [{
      jobId: "test-3",
      cli: "claude",
      status: "running",
      pid: process.pid,
      startedAt: tenSecondsAgo
    }];
    const health = monitor.checkJobHealth(jobs);
    expect(health[0].runningForMs).toBeGreaterThanOrEqual(9000);
    expect(health[0].runningForMs).toBeLessThan(20000);
  });
});
