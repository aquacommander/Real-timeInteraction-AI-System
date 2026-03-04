type LogLevel = "INFO" | "WARN" | "ERROR";

export function log(level: LogLevel, event: string, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${timestamp}] [${level}] ${event}${payload}`);
}
