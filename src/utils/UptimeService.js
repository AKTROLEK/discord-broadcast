const http = require('http');
const https = require('https');
const { URL } = require('url');

const { createLogger } = require('./helpers');

class UptimeService {
    constructor(options = {}) {
        this.options = {
            enabled: true,
            interval: 5 * 60 * 1000,
            pingUrl: '',
            ...options
        };

        this.logger = createLogger('Uptime');
        this.timer = null;
    }

    start() {
        if (!this.options.enabled) {
            this.logger.info('Uptime monitor disabled via configuration.');
            return;
        }

        if (this.timer) {
            this.logger.warn('Uptime monitor already running.');
            return;
        }

        const interval = Number(this.options.interval) || (5 * 60 * 1000);
        this.logger.info(`Starting uptime heartbeat${this.options.pingUrl ? ` with ping URL ${this.options.pingUrl}` : ''}.`);

        this.timer = setInterval(() => this.heartbeat(), interval);
        this.timer.unref?.();
        this.heartbeat();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.logger.info('Stopped uptime heartbeat.');
        }
    }

    heartbeat() {
        if (!this.options.pingUrl) {
            this.logger.info('Heartbeat tick - no external ping configured.');
            return;
        }

        try {
            const target = new URL(this.options.pingUrl);
            const client = target.protocol === 'https:' ? https : http;

            const request = client.get(target, (response) => {
                response.resume();
                this.logger.info(`Heartbeat ping sent to ${this.options.pingUrl} - status ${response.statusCode}`);
            });

            request.on('error', (error) => {
                this.logger.error(`Heartbeat request failed: ${error.message}`);
            });

            request.setTimeout(5000, () => {
                request.destroy(new Error('Heartbeat request timed out'));
            });
        } catch (error) {
            this.logger.error(`Invalid heartbeat URL: ${error.message}`);
        }
    }
}

module.exports = UptimeService;
