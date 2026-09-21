import { appendFile } from "fs/promises";
import { config } from "../config.js";

enum LogType {
    EMERGENCY = 'EMERGENCY',
    ERROR = 'ERROR',
    WARN = 'WARN',
    INFO = 'INFO',
    DEBUG = 'DEBUG'
}

export class Logger {
    private static data: string[] = [];
    private static logIntervalMs = 30000;
    static logInterval: NodeJS.Timeout | null = setInterval(() => this.writeLogs(), this.logIntervalMs);

    private constructor() { }

    static log(message: string) {
        this._log(LogType.INFO, message);
    }

    static debug(context: string, message: string, error?: Error): void {
        const msg = `${context} - ${message}` + `${error ? `\n${error.stack}` : ''}`
        this._log(LogType.DEBUG, msg);
    }

    static info(context: string, message: string, error?: Error): void {
        const msg = `${context} - ${message}` + `${error ? `\n${error.stack}` : ''}`
        this._log(LogType.INFO, msg);
    }

    static warn(context: string, message: string, error?: Error): void {
        const msg = `${context} - ${message}` + `${error ? `\n${error.stack}` : ''}`
        this._log(LogType.WARN, msg);
    }

    static error(context: string, message: string, error?: Error): void {
        const msg = `${context} - ${message}` + `${error ? `\n${error.stack}` : ''}`
        this._log(LogType.ERROR, msg);
    }

    static emergency(context: string, message: string, error?: Error): void {
        const msg = `${context} - ${message}` + `${error ? `\n${error.stack}` : ''}`
        this._log(LogType.EMERGENCY, msg);
    }

    private static _log(type: LogType, message: string) {
        const msg = `${this._getTimestamp()} [${type}] ${message}`;
        console.log(msg);

        if (config.logToFile) this.data.push(msg);
    };

    private static async writeLogs() {
        if (!config.logToFile || this.data.length === 0) return;

        try {
            await appendFile(config.logPath, this.data.join('\n') + '\n');
            this.data = [];
        } catch (error) {
            console.error(`[ FILE WRITE ERROR ]: Failed to write logs - ${error}`);
        }
    }

    static async stopLogger() {
        if (!config.logToFile) return;

        if (Logger.logInterval) {
            clearInterval(Logger.logInterval);
            Logger.logInterval = null;
        }

        return await this.writeLogs();
    }

    private static _getTimestamp(): string {
        return new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'short',
            timeStyle: 'medium',
            hour12: false
        }).format(new Date());
    }
}